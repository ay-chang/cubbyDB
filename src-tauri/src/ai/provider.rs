//! Anthropic Messages API client + tool-calling loop.

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};

use super::tools::{tool_definitions, ToolOutcome};
use super::{AiChatResult, ChatMessage, ModelInfo, ToolTrace, MAX_TOOL_ITERATIONS};
use crate::db::{DbError, DbErrorKind};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=1000";
const API_VERSION: &str = "2023-06-01";
/// Used when the user hasn't picked a model yet, and as a last resort if
/// `list_models` can't be reached (offline, bad key, API hiccup).
pub const DEFAULT_MODEL: &str = "claude-sonnet-5";

/// Caps thinking *plus* response text together, not just the visible answer.
/// That distinction is why this isn't small: on models where adaptive
/// thinking is on by default (Claude Opus 5, selectable from the Settings
/// model picker), a tight budget gets spent thinking and the actual reply
/// truncates mid-sentence with no error — the response just stops. 2048 was
/// too tight for exactly that reason.
const MAX_TOKENS: u32 = 8192;

/// How hard the model works per turn. Database questions are mostly lookup
/// and light reasoning, so the default tier buys little over `medium` while
/// costing latency and tokens on every single message.
const EFFORT: &str = "medium";

/// Live-fetches the models available to this key. The Models API returns
/// newest-released first, so the list is shown in that order as-is.
pub async fn list_models(api_key: &str) -> Result<Vec<ModelInfo>, DbError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(MODELS_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .send()
        .await
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Anthropic request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(DbError::new(
            DbErrorKind::Internal,
            format!("Anthropic API error ({status}): {text}"),
        ));
    }

    let parsed: ModelsResponse = resp.json().await.map_err(|e| {
        DbError::new(DbErrorKind::Internal, format!("Anthropic response parse failed: {e}"))
    })?;

    Ok(parsed
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id,
            label: m.display_name,
            supports_effort: m
                .capabilities
                .and_then(|c| c.effort)
                .map(|e| e.supported)
                .unwrap_or(false),
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    display_name: String,
    /// The Models API reports per-model capabilities. We read exactly one:
    /// whether `output_config.effort` is accepted. It isn't universal —
    /// Haiku 4.5 rejects it outright — so sending it blind would 400 every
    /// request for anyone who picked such a model from the Settings dropdown.
    #[serde(default)]
    capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Deserialize)]
struct ModelCapabilities {
    #[serde(default)]
    effort: Option<CapabilitySupport>,
}

#[derive(Debug, Deserialize)]
struct CapabilitySupport {
    supported: bool,
}

/// Runs one user turn to completion.
///
/// `run_tool` is supplied by `commands::ai_chat` rather than built here: it
/// owns the session lock and the reconnect-on-drop retry, and this module
/// has no business knowing about either. It takes `(tool_name, input)` and
/// resolves to whatever `ai::tools::execute` produced.
pub async fn run_loop<F, Fut>(
    api_key: &str,
    model: &str,
    send_effort: bool,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    run_tool: F,
) -> Result<AiChatResult, DbError>
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<ToolOutcome, DbError>>,
{
    let client = reqwest::Client::new();
    let tools = tool_definitions();

    // Anthropic's own wire-format conversation, seeded from the plain
    // history the frontend sent — grows with tool_use/tool_result blocks as
    // the loop runs, but never leaves this function.
    let mut wire_messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut trace = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        // `system` is sent as a block array (not a bare string) purely so it
        // can carry `cache_control`. Anthropic renders the request as
        // tools -> system -> messages and caching is a prefix match, so a
        // breakpoint on the last system block caches the tool definitions
        // and the whole schema together — the expensive, byte-identical part
        // of every turn in a conversation.
        //
        // This only holds while the prefix is stable: anything per-request
        // in the system prompt (a timestamp, a session id) silently
        // invalidates it on every call. `build_system_prompt` deliberately
        // includes only a date, which is stable far longer than the cache's
        // own TTL.
        let mut body = json!({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "system": [{
                "type": "text",
                "text": system_prompt,
                "cache_control": { "type": "ephemeral" },
            }],
            "messages": wire_messages,
            "tools": tools,
        });
        // Only for models that actually accept it — see `send_effort`'s
        // source in `AiConfig::model_supports_effort`.
        if send_effort {
            body["output_config"] = json!({ "effort": EFFORT });
        }

        let resp = client
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(DbError::new(
                DbErrorKind::Internal,
                format!("Anthropic API error ({status}): {text}"),
            ));
        }

        let parsed: AnthropicResponse = resp.json().await.map_err(|e| {
            DbError::new(DbErrorKind::Internal, format!("Anthropic response parse failed: {e}"))
        })?;

        // Cache effectiveness is invisible without this. A healthy multi-turn
        // chat reads ~0 cached tokens on its first message and thousands on
        // every one after; a steady 0 means something per-request leaked into
        // the system prompt and the cache never hits. Cheap to leave in — one
        // line per turn on stderr.
        if let Some(usage) = &parsed.usage {
            eprintln!(
                "[cubbydb][ai] cache write={} read={} in={} out={}",
                usage.cache_creation_input_tokens.unwrap_or(0),
                usage.cache_read_input_tokens.unwrap_or(0),
                usage.input_tokens.unwrap_or(0),
                usage.output_tokens.unwrap_or(0),
            );
        }

        // Content blocks are kept as raw `Value`s rather than deserialized
        // into a typed struct — Anthropic has several block shapes beyond
        // `text`/`tool_use` (`thinking`, `redacted_thinking`, citations, and
        // whatever it adds next), each with its own required fields, and a
        // struct only modeling the two this loop cares about silently
        // dropped every field it didn't know — which is exactly what broke
        // this multi-turn tool-call replay twice already (a missing
        // `tool_use.name`, then a stray `"text": null` on a `tool_use`
        // block). Reading straight from the JSON below and replaying
        // `parsed.content` verbatim means nothing Anthropic sends can ever
        // be lost or malformed on the way back to it, regardless of what
        // block types show up.
        // (tool_use_id, tool_name, input)
        let mut tool_uses: Vec<(String, String, Value)> = Vec::new();
        let mut text = String::new();
        for block in &parsed.content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    tool_uses.push((id, name, input));
                }
                _ => {}
            }
        }

        if tool_uses.is_empty() {
            return Ok(AiChatResult { reply: text, trace });
        }

        // Record the assistant's own turn exactly as the API sent it —
        // including any thinking/citation/etc. blocks alongside the
        // tool_use ones — before appending the tool results.
        wire_messages.push(json!({ "role": "assistant", "content": parsed.content }));

        // Anthropic can request several tools in one turn, and every
        // `tool_result` must come back in a *single* user message — splitting
        // them across messages trains the model out of parallel calls.
        let mut tool_results = Vec::new();
        for (tool_use_id, name, input) in tool_uses {
            let (content, is_error) = match run_tool(name.clone(), input).await {
                Ok(outcome) => {
                    trace.push(outcome.trace);
                    (outcome.content, false)
                }
                Err(e) => {
                    // A failed tool is reported to the model rather than
                    // aborting the turn: a rejected write, a typo'd column,
                    // or a missing table are all things it can see and
                    // recover from on the next iteration.
                    trace.push(ToolTrace {
                        tool: name,
                        detail: String::new(),
                        row_count: None,
                        error: Some(e.message.clone()),
                    });
                    (format!("Error: {}", e.message), true)
                }
            };

            tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }));
        }
        wire_messages.push(json!({ "role": "user", "content": tool_results }));
    }

    Err(DbError::new(
        DbErrorKind::Internal,
        "The AI kept working without reaching an answer — stopped after the iteration limit.",
    ))
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<Value>,
    /// Absent on older API versions / unexpected shapes — logging is
    /// best-effort diagnostics, never load-bearing, so every field is
    /// optional rather than failing the whole parse over telemetry.
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
}
