//! AI assistant service: the schema-aware system prompt, the shared types
//! the (Anthropic-only) tool-call loop in `provider.rs` uses, and this
//! feature's own config/chat persistence (`config.rs`, `chats.rs`).
//!
//! Deliberately Anthropic-only, not a multi-provider abstraction: an earlier
//! version of this supported OpenAI too, but with only one provider left
//! there was nothing left to abstract — `commands::ai_chat` calls
//! `provider::run_loop`/`provider::list_models` directly rather than
//! through a dispatcher. Everything here is what's actually shared between
//! "build the prompt" and "run the loop": the plain-text message shape the
//! frontend speaks, the row-truncation rule, and the iteration cap.

pub mod chats;
pub mod config;
pub mod prompt;
pub mod provider;
pub mod tools;

use serde::{Deserialize, Serialize};

use crate::db::QueryResult;

/// One turn of the conversation, exactly as the frontend sends/receives it —
/// `role`/`content` are all a live `ai_chat` turn cares about (Anthropic's
/// `tool_use`/`tool_result` content-block scaffolding lives only inside a
/// single `run_loop` call and is never round-tripped: each new user message
/// starts the model fresh from this plain history, and any tool calls it
/// needs are re-derived within that turn). `trace` is unread by the loop
/// itself — it's carried through so a *persisted* chat's messages (see
/// `chats.rs`) keep their "ran: ... — N rows" disclosures when reopened.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub trace: Option<Vec<ToolTrace>>,
}

/// Which table the user was looking at when they sent a message, if any —
/// passed straight through from the active tab's `source` on the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTableRef {
    pub schema: String,
    pub table: String,
}

/// One executed tool call, surfaced to the frontend for transparency — the
/// panel shows what ran under the answer instead of a black box.
/// `Deserialize` is for round-tripping through a persisted chat's messages
/// (see `ChatMessage.trace`) — a live turn's own `AiChatResult.trace` is
/// still frontend-bound only, never read back in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTrace {
    /// Which tool ran (`run_sql`, `describe_table`, …). Defaulted because
    /// chats saved before the agent had more than one tool have no such
    /// field; those entries were all `run_sql`.
    #[serde(default = "legacy_tool_name")]
    pub tool: String,
    /// What it ran on: the SQL for query tools, the table name for
    /// `describe_table`, the search term for `search_schema`.
    ///
    /// `alias = "sql"` reads chats persisted before this field was
    /// generalized, so old saved conversations still render. They re-save
    /// under the new name on their next turn.
    #[serde(alias = "sql")]
    pub detail: String,
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

fn legacy_tool_name() -> String {
    "run_sql".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResult {
    pub reply: String,
    pub trace: Vec<ToolTrace>,
}

/// One model currently on offer, for the Settings model picker. `label` is
/// Anthropic's human-readable `display_name`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    /// Whether this model accepts `output_config.effort`. Not universal —
    /// Haiku 4.5 rejects it with a 400 — so it's captured at pick time and
    /// persisted alongside the choice rather than assumed.
    pub supports_effort: bool,
}

/// Hard cap on ask<->tool round trips within one turn, so a model stuck
/// re-querying can't loop forever (or run up the user's bill).
pub const MAX_TOOL_ITERATIONS: u32 = 6;

/// How many rows of a tool result are fed back to the model — independent of
/// the app's own 500-row UI pagination cap, this bounds token usage.
pub const MAX_TOOL_RESULT_ROWS: usize = 50;

/// Renders a tool result as plain text for the model — full row data would
/// otherwise bloat every subsequent turn's token count for no benefit, so
/// this caps at `MAX_TOOL_RESULT_ROWS` and notes the real total.
pub fn summarize_for_model(result: &QueryResult) -> String {
    if result.columns.is_empty() {
        return result
            .command_tag
            .clone()
            .unwrap_or_else(|| "(no rows returned)".to_string());
    }

    let total = result.row_count;
    let shown = result.rows.len().min(MAX_TOOL_RESULT_ROWS);
    let mut out = format!(
        "columns: {}\n",
        result
            .columns
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
    );
    for row in &result.rows[..shown] {
        let cells: Vec<String> = row
            .iter()
            .map(|v| v.clone().unwrap_or_else(|| "NULL".to_string()))
            .collect();
        out.push_str(&cells.join(" | "));
        out.push('\n');
    }
    if total > shown {
        out.push_str(&format!("... ({total} rows total, showing first {shown})\n"));
    }
    out
}
