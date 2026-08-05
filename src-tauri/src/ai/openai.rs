//! OpenAI Responses API client + tool-calling loop.

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};

use super::tools::{tool_definitions, ToolOutcome};
use super::{
    AiChatResult, ChatMessage, ModelInfo, ReasoningEffort, ToolTrace, MAX_TOOL_ITERATIONS,
};
use crate::db::{DbError, DbErrorKind};

const API_URL: &str = "https://api.openai.com/v1/responses";
const MODELS_URL: &str = "https://api.openai.com/v1/models";
/// Explicit low-latency GPT-5.6 model. Avoid the unsuffixed alias because it
/// resolves to Sol and cannot represent a real picker choice.
pub const DEFAULT_MODEL: &str = "gpt-5.6-luna";
const MAX_OUTPUT_TOKENS: u32 = 8192;

/// Live-fetches models visible to the key and keeps text/reasoning families
/// that can plausibly serve the assistant's Responses API function tools.
pub async fn list_models(api_key: &str) -> Result<Vec<ModelInfo>, DbError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(MODELS_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| openai_request_error(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(openai_api_error(status.as_u16(), &text));
    }

    let parsed: ModelsResponse = resp.json().await.map_err(|e| {
        DbError::new(
            DbErrorKind::Internal,
            format!("OpenAI response parse failed: {e}"),
        )
    })?;

    let mut models: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .filter(|model| is_assistant_model(&model.id) && model.id != "gpt-5.6")
        .map(|model| ModelInfo {
            supports_effort: supports_reasoning_effort(&model.id),
            supported_reasoning_efforts: reasoning_efforts(&model.id),
            default_reasoning_effort: supports_reasoning_effort(&model.id)
                .then_some(ReasoningEffort::Medium),
            label: model.id.clone(),
            id: model.id,
        })
        .collect();
    models.sort_by(|a, b| {
        model_rank(&a.id)
            .cmp(&model_rank(&b.id))
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(models)
}

fn model_rank(id: &str) -> u8 {
    match id {
        "gpt-5.6-luna" => 0,
        "gpt-5.6-sol" => 1,
        "gpt-5.6-terra" => 2,
        _ => 3,
    }
}

fn is_assistant_model(id: &str) -> bool {
    let text_family = ["gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3", "o4"]
        .iter()
        .any(|prefix| id.starts_with(prefix));
    text_family
        && ![
            "audio",
            "realtime",
            "transcribe",
            "tts",
            "image",
            "search-preview",
            "moderation",
            "deep-research",
        ]
        .iter()
        .any(|part| id.contains(part))
}

fn supports_reasoning_effort(id: &str) -> bool {
    id.starts_with("gpt-5") || id.starts_with('o')
}

fn reasoning_efforts(id: &str) -> Vec<ReasoningEffort> {
    if id.starts_with("gpt-5.6") {
        vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ]
    } else if supports_reasoning_effort(id) {
        vec![
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ]
    } else {
        Vec::new()
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// Runs one user turn to completion with stateless Responses API requests.
/// Every response output item is replayed before function outputs, as the
/// API requires for reasoning models and `store: false` requests.
pub async fn run_loop<F, Fut>(
    api_key: &str,
    model: &str,
    reasoning_effort: Option<ReasoningEffort>,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    run_tool: F,
) -> Result<AiChatResult, DbError>
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<ToolOutcome, DbError>>,
{
    let client = reqwest::Client::new();
    let tools = openai_tool_definitions();
    let mut input: Vec<Value> = messages
        .iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let mut trace = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let mut body = json!({
            "model": model,
            "instructions": system_prompt,
            "input": input,
            "tools": tools,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            // Database schemas and row samples should not be retained as
            // provider-side response state. The complete tool loop is
            // replayed explicitly below instead.
            "store": false,
        });
        if let Some(effort) = reasoning_effort {
            body["reasoning"] = json!({ "effort": effort.as_str() });
        }

        let resp = client
            .post(API_URL)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| openai_request_error(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(openai_api_error(status.as_u16(), &text));
        }

        let parsed: OpenAiResponse = resp.json().await.map_err(|e| {
            DbError::new(
                DbErrorKind::Internal,
                format!("OpenAI response parse failed: {e}"),
            )
        })?;

        if let Some(usage) = &parsed.usage {
            eprintln!(
                "[cubbydb][ai] provider=openai cached={} in={} out={}",
                usage
                    .input_tokens_details
                    .as_ref()
                    .and_then(|details| details.cached_tokens)
                    .unwrap_or(0),
                usage.input_tokens.unwrap_or(0),
                usage.output_tokens.unwrap_or(0),
            );
        }

        let reply = response_text(&parsed.output);
        let calls = function_calls(&parsed.output);
        if calls.is_empty() {
            return Ok(AiChatResult { reply, trace });
        }

        // Preserve message and reasoning items as well as the function calls.
        // Reasoning models require those items to precede the matching tool
        // outputs when conversation state is managed manually.
        input.extend(parsed.output);

        for call in calls {
            let tool_input =
                serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let (content, error) = match run_tool(call.name.clone(), tool_input).await {
                Ok(outcome) => {
                    trace.push(outcome.trace);
                    (outcome.content, None)
                }
                Err(e) => {
                    trace.push(ToolTrace {
                        tool: call.name,
                        detail: String::new(),
                        row_count: None,
                        error: Some(e.message.clone()),
                    });
                    (format!("Error: {}", e.message), Some(e.message))
                }
            };

            input.push(json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": if error.is_some() { format!("Tool failed: {content}") } else { content },
            }));
        }
    }

    Err(DbError::new(
        DbErrorKind::Internal,
        "The AI kept working without reaching an answer — stopped after the iteration limit.",
    ))
}

/// The existing neutral definitions use Anthropic's `input_schema` key.
/// Responses function tools use the same JSON Schema under `parameters`.
fn openai_tool_definitions() -> Value {
    let Some(definitions) = tool_definitions().as_array().cloned() else {
        return json!([]);
    };
    Value::Array(
        definitions
            .into_iter()
            .map(|definition| {
                json!({
                    "type": "function",
                    "name": definition.get("name").cloned().unwrap_or(Value::Null),
                    "description": definition.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": definition.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                })
            })
            .collect(),
    )
}

fn response_text(output: &[Value]) -> String {
    output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn function_calls(output: &[Value]) -> Vec<FunctionCall> {
    output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter_map(|item| {
            Some(FunctionCall {
                call_id: item.get("call_id")?.as_str()?.to_string(),
                name: item.get("name")?.as_str()?.to_string(),
                arguments: item.get("arguments")?.as_str()?.to_string(),
            })
        })
        .collect()
}

struct FunctionCall {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    output: Vec<Value>,
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
    input_tokens_details: Option<InputTokenDetails>,
}

#[derive(Debug, Deserialize)]
struct InputTokenDetails {
    #[serde(default)]
    cached_tokens: Option<u64>,
}

fn openai_request_error(message: String) -> DbError {
    DbError::new(
        DbErrorKind::Internal,
        format!("OpenAI request failed: {message}"),
    )
}

fn openai_api_error(status: u16, body: &str) -> DbError {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ApiError>,
    }
    #[derive(Deserialize)]
    struct ApiError {
        message: Option<String>,
    }

    let message = serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.message)
        .unwrap_or_else(|| body.to_string());
    DbError::new(
        DbErrorKind::Internal,
        format!("OpenAI API error ({status}): {message}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_tools_use_parameters() {
        let tools = openai_tool_definitions();
        let first = &tools.as_array().unwrap()[0];
        assert_eq!(first["type"], "function");
        assert!(first.get("parameters").is_some());
        assert!(first.get("input_schema").is_none());
    }

    #[test]
    fn extracts_text_and_function_calls() {
        let output = vec![
            json!({ "type": "message", "content": [{ "type": "output_text", "text": "hello" }] }),
            json!({ "type": "function_call", "call_id": "call_1", "name": "run_sql", "arguments": "{\"sql\":\"select 1\"}" }),
        ];
        assert_eq!(response_text(&output), "hello");
        let calls = function_calls(&output);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "run_sql");
    }
}
