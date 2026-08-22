//! AI assistant service: the schema-aware system prompt, the shared types
//! the provider tool-call loops use, and this
//! feature's own config/chat persistence (`config.rs`, `chats.rs`).
//!
//! Anthropic and OpenAI keep their wire formats in separate modules while
//! sharing the prompt, tool execution, persistence, and frontend message
//! shapes. Everything here is what's actually shared between
//! "build the prompt" and "run the loop": the plain-text message shape the
//! frontend speaks, the row-truncation rule, and the iteration cap.

pub mod audit;
pub mod chats;
pub mod claude_code;
pub mod codex;
pub mod config;
pub mod filter;
pub mod openai;
pub mod prompt;
pub mod provider;
mod read_only;
pub(crate) mod relevance;
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

/// Reasoning levels shared by OpenAI's Responses API and Codex app-server.
/// Codex advertises the subset each model supports through `model/list`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Low,
    #[default]
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

/// One model currently on offer for the Settings picker, including the exact
/// reasoning levels advertised by Codex app-server when available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    /// Whether this model accepts `output_config.effort`. Not universal —
    /// Haiku 4.5 rejects it with a 400 — so it's captured at pick time and
    /// persisted alongside the choice rather than assumed.
    pub supports_effort: bool,
    /// Exact effort values advertised by Codex, or the documented safe set
    /// for an OpenAI API model. Empty for providers without this selector.
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub default_reasoning_effort: Option<ReasoningEffort>,
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
        out.push_str(&format!(
            "... ({total} rows total, showing first {shown})\n"
        ));
    }
    out
}

/// How long a single request to a provider is allowed to sit open. Generous:
/// the response only arrives after the model finishes generating (neither
/// direct-API path streams), so this has to cover worst-case generation
/// time, not just network latency. A hung connection previously blocked the
/// panel forever — `codex.rs`/`claude_code.rs` already bound their own calls
/// this way, this brings the two direct-HTTP providers in line with them.
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A `reqwest::Client` with `HTTP_TIMEOUT` applied. Shared by `provider.rs`
/// and `openai.rs` — the two providers that talk to their API over HTTP
/// directly, rather than through a CLI's own app-server (which manages its
/// own timeouts).
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        // `build()` only fails on TLS backend initialization — already
        // proven to work elsewhere in this process (the Postgres driver's
        // own TLS), so this is unreachable in practice. Fall back to an
        // unbounded client rather than panic if it somehow ever isn't.
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Attempts before giving up on a transient failure.
const MAX_SEND_ATTEMPTS: u32 = 3;

/// Sends a request, retrying with backoff on the failures worth retrying:
/// rate limiting, transient server-side overload, and connection-level
/// hiccups. Anything else — a 400, a 401, a malformed request — is a real
/// problem retrying won't fix, so it's returned immediately on the first
/// attempt. `build` is called fresh on every attempt rather than the
/// request being cloned, since rebuilding a small JSON POST is cheap and
/// sidesteps needing the body to be cloneable.
pub(crate) async fn send_with_retry<F>(build: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match build().send().await {
            Ok(resp) if attempt < MAX_SEND_ATTEMPTS && is_retryable_status(resp.status().as_u16()) => {
                eprintln!(
                    "[cubbydb][ai] {} on attempt {attempt}, retrying",
                    resp.status()
                );
                tokio::time::sleep(backoff_delay(attempt)).await;
            }
            Ok(resp) => return Ok(resp),
            Err(e) if attempt < MAX_SEND_ATTEMPTS && (e.is_timeout() || e.is_connect()) => {
                eprintln!("[cubbydb][ai] transport error on attempt {attempt}: {e}, retrying");
                tokio::time::sleep(backoff_delay(attempt)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_retryable_status(status: u16) -> bool {
    // 429 rate limiting; 500/502/503 generic server-side trouble; 529 is
    // Anthropic's own "overloaded" code.
    matches!(status, 429 | 500 | 502 | 503 | 529)
}

fn backoff_delay(attempt: u32) -> std::time::Duration {
    let secs = 2u64.saturating_pow(attempt.saturating_sub(1)).min(8);
    std::time::Duration::from_secs(secs)
}

/// Safety cap on how many of a conversation's messages are replayed into a
/// fresh provider request. `chats.rs` still persists the full transcript —
/// this only bounds what gets sent out, so an extremely long conversation
/// degrades (older middle turns dropped) instead of eventually failing
/// outright once it's grown large enough to blow the context window.
///
/// The first message is always kept even when it falls outside the tail:
/// it's what `PromptContext::conversation_seed` ranks the schema against for
/// the whole conversation (see `prompt.rs`), and losing it would silently
/// change that ranking — and the cached system prompt's relevant-tables
/// list — partway through a chat.
pub const MAX_HISTORY_MESSAGES: usize = 40;

/// Applies `MAX_HISTORY_MESSAGES`: the first message, plus the most recent
/// messages up to the cap.
pub fn cap_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    if messages.len() <= MAX_HISTORY_MESSAGES {
        return messages.to_vec();
    }
    let mut capped = Vec::with_capacity(MAX_HISTORY_MESSAGES);
    capped.push(messages[0].clone());
    capped.extend_from_slice(&messages[messages.len() - (MAX_HISTORY_MESSAGES - 1)..]);
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(content: &str) -> ChatMessage {
        ChatMessage { role: "user".to_string(), content: content.to_string(), trace: None }
    }

    #[test]
    fn cap_history_is_a_no_op_under_the_limit() {
        let messages: Vec<ChatMessage> = (0..5).map(|i| msg(&i.to_string())).collect();
        let capped = cap_history(&messages);
        assert_eq!(capped.len(), 5);
    }

    #[test]
    fn cap_history_keeps_the_first_message_and_the_recent_tail() {
        let messages: Vec<ChatMessage> =
            (0..MAX_HISTORY_MESSAGES + 10).map(|i| msg(&i.to_string())).collect();
        let capped = cap_history(&messages);
        assert_eq!(capped.len(), MAX_HISTORY_MESSAGES);
        assert_eq!(capped[0].content, "0");
        // The most recent message is still present.
        assert_eq!(capped.last().unwrap().content, (messages.len() - 1).to_string());
        // Something from the dropped middle is genuinely gone.
        assert!(!capped.iter().any(|m| m.content == "5"));
    }

    #[test]
    fn retryable_statuses_are_exactly_rate_limit_and_server_trouble() {
        for status in [429, 500, 502, 503, 529] {
            assert!(is_retryable_status(status), "{status} should be retryable");
        }
        for status in [200, 400, 401, 404] {
            assert!(!is_retryable_status(status), "{status} should not be retryable");
        }
    }
}
