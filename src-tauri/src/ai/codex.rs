//! Codex CLI app-server integration for ChatGPT subscription access.
//!
//! CubbyDB never reads or copies Codex access tokens. The official Codex CLI
//! owns browser login, token storage, refresh, model discovery, and inference.
//! CubbyDB uses the user's current Codex profile (`CODEX_HOME`, or Codex's
//! normal default) just like the CLI and t3code, so an existing `codex login`
//! is immediately available. The database turn itself still runs in an empty,
//! read-only CubbyDB workspace and exposes only read-only database tools.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

use super::tools::{tool_definitions, ToolOutcome};
use super::{
    AiChatResult, ChatMessage, ModelInfo, ReasoningEffort, ToolTrace, MAX_TOOL_ITERATIONS,
};
use crate::db::{DbError, DbErrorKind};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const DEFAULT_MODEL: &str = "gpt-5.6-luna";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

struct CodexClient {
    _child: Child,
    input: BufWriter<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    version: Option<String>,
}

impl CodexClient {
    async fn connect(data_dir: &Path) -> Result<Self, DbError> {
        let workspace = data_dir.join("codex-workspace");
        std::fs::create_dir_all(&workspace).map_err(file_error)?;
        restrict_directory(&workspace);

        let mut last_not_found = None;
        for binary in codex_candidates() {
            let mut command = Command::new(&binary);
            command
                .arg("app-server")
                .current_dir(&workspace)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            match command.spawn() {
                Ok(mut child) => {
                    let input = child
                        .stdin
                        .take()
                        .ok_or_else(|| internal("Codex stdin was unavailable."))?;
                    let output = child
                        .stdout
                        .take()
                        .ok_or_else(|| internal("Codex stdout was unavailable."))?;
                    let mut client = Self {
                        _child: child,
                        input: BufWriter::new(input),
                        lines: BufReader::new(output).lines(),
                        next_id: 1,
                        version: None,
                    };
                    let initialized = client
                        .request(
                            "initialize",
                            json!({
                                "clientInfo": {
                                    "name": "cubbydb",
                                    "title": "CubbyDB",
                                    "version": env!("CARGO_PKG_VERSION"),
                                },
                                "capabilities": { "experimentalApi": true },
                            }),
                        )
                        .await?;
                    client.version = initialized
                        .get("userAgent")
                        .and_then(Value::as_str)
                        .and_then(parse_codex_version);
                    client.notify("initialized", json!({})).await?;
                    return Ok(client);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    last_not_found = Some(error);
                }
                Err(error) => {
                    return Err(internal(format!("Could not start Codex CLI: {error}")));
                }
            }
        }

        let suffix = last_not_found
            .map(|error| format!(" ({error})"))
            .unwrap_or_default();
        Err(internal(format!(
            "Codex CLI is not installed or could not be found{suffix}. Install it, then return to Settings."
        )))
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), DbError> {
        self.write(&json!({ "method": method, "params": params }))
            .await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, DbError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "id": id, "method": method, "params": params }))
            .await?;
        timeout(REQUEST_TIMEOUT, async {
            loop {
                let message = self.read().await?;
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    return Err(protocol_error(error));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| internal(format!("Codex did not answer `{method}` in time.")))?
    }

    async fn write(&mut self, message: &Value) -> Result<(), DbError> {
        let mut bytes = serde_json::to_vec(message)
            .map_err(|error| internal(format!("Could not encode Codex request: {error}")))?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|error| internal(format!("Could not write to Codex: {error}")))?;
        self.input
            .flush()
            .await
            .map_err(|error| internal(format!("Could not flush Codex request: {error}")))
    }

    async fn read(&mut self) -> Result<Value, DbError> {
        loop {
            let line = self
                .lines
                .next_line()
                .await
                .map_err(|error| internal(format!("Could not read Codex response: {error}")))?
                .ok_or_else(|| internal("Codex app-server stopped unexpectedly."))?;
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }
}

pub async fn status(data_dir: &Path) -> CodexStatus {
    let mut client = match CodexClient::connect(data_dir).await {
        Ok(client) => client,
        Err(error) => {
            return CodexStatus {
                error: Some(error.message),
                ..CodexStatus::default()
            };
        }
    };
    let version = client.version.clone();
    match client.request("account/read", json!({})).await {
        Ok(response) => {
            let account = response.get("account").filter(|value| !value.is_null());
            CodexStatus {
                installed: true,
                authenticated: account.is_some(),
                email: account
                    .and_then(|value| value.get("email"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                plan_type: account
                    .and_then(|value| value.get("planType"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                version,
                error: None,
            }
        }
        Err(error) => CodexStatus {
            installed: true,
            version,
            error: Some(error.message),
            ..CodexStatus::default()
        },
    }
}

pub async fn start_login(data_dir: &Path) -> Result<(), DbError> {
    let mut client = CodexClient::connect(data_dir).await?;
    let response = client
        .request(
            "account/login/start",
            json!({
                "type": "chatgpt",
                "useHostedLoginSuccessPage": true,
                "appBrand": "chatgpt",
            }),
        )
        .await?;
    let auth_url = response
        .get("authUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| internal("Codex did not return a ChatGPT sign-in URL."))?;
    open_browser(auth_url)?;

    // The local OAuth callback belongs to this app-server process, so keep it
    // alive after the Tauri command returns. Settings polls `account/read`
    // through a separate short-lived process and notices completion.
    tokio::spawn(async move {
        let _ = timeout(LOGIN_TIMEOUT, async {
            while let Ok(message) = client.read().await {
                if message.get("method").and_then(Value::as_str) == Some("account/login/completed")
                {
                    break;
                }
            }
        })
        .await;
    });
    Ok(())
}

pub async fn list_models(data_dir: &Path) -> Result<Vec<ModelInfo>, DbError> {
    let mut client = CodexClient::connect(data_dir).await?;
    require_account(&mut client).await?;
    let response = client.request("model/list", json!({})).await?;
    let models = response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let supported_reasoning_efforts = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    serde_json::from_value(
                        effort
                            .get("reasoningEffort")
                            .cloned()
                            .unwrap_or(Value::Null),
                    )
                    .ok()
                })
                .collect::<Vec<ReasoningEffort>>();
            Some(ModelInfo {
                id: model.get("id")?.as_str()?.to_string(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| model.get("id").and_then(Value::as_str).unwrap_or("Codex"))
                    .to_string(),
                supports_effort: !supported_reasoning_efforts.is_empty(),
                supported_reasoning_efforts,
                default_reasoning_effort: model
                    .get("defaultReasoningEffort")
                    .cloned()
                    .and_then(|effort| serde_json::from_value(effort).ok()),
            })
        })
        .collect::<Vec<_>>();
    let mut models = models;
    models.sort_by(|a, b| {
        codex_model_rank(&a.id)
            .cmp(&codex_model_rank(&b.id))
            .then_with(|| a.label.cmp(&b.label))
    });
    Ok(models)
}

fn codex_model_rank(id: &str) -> u8 {
    match id {
        "gpt-5.6-luna" => 0,
        "gpt-5.6-sol" => 1,
        "gpt-5.6-terra" => 2,
        _ => 3,
    }
}

pub async fn run_loop<F, Fut>(
    data_dir: &Path,
    model: &str,
    reasoning_effort: ReasoningEffort,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    mut run_tool: F,
) -> Result<AiChatResult, DbError>
where
    F: FnMut(String, Value) -> Fut,
    Fut: Future<Output = Result<ToolOutcome, DbError>>,
{
    let mut client = CodexClient::connect(data_dir).await?;
    require_account(&mut client).await?;

    let dynamic_tools = tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": tool.get("input_schema").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect::<Vec<_>>();

    let workspace = data_dir.join("codex-workspace");
    let instructions = format!(
        "{system_prompt}\n\nYou are running inside CubbyDB, not a coding workspace. Use only the supplied database tools. Never use shell, filesystem, network, MCP, skills, or code-editing tools. Do not ask for approval."
    );
    let thread = client
        .request(
            "thread/start",
            json!({
                "model": model,
                "cwd": workspace,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": true,
                "baseInstructions": instructions,
                "dynamicTools": dynamic_tools,
            }),
        )
        .await?;
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| internal("Codex did not return a thread id."))?
        .to_string();

    let transcript = messages
        .iter()
        .map(|message| {
            let role = if message.role == "assistant" {
                "Assistant"
            } else {
                "User"
            };
            format!("{role}: {}", message.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let turn_id = client.next_id;
    client.next_id += 1;
    client
        .write(&json!({
            "id": turn_id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "effort": reasoning_effort.as_str(),
                "input": [{ "type": "text", "text": transcript, "textElements": [] }],
            }
        }))
        .await?;

    timeout(TURN_TIMEOUT, async {
        let mut trace = Vec::new();
        let mut reply = String::new();
        let mut tool_calls = 0_u32;
        loop {
            let message = client.read().await?;
            if message.get("id").and_then(Value::as_u64) == Some(turn_id)
                && message.get("error").is_some()
            {
                return Err(protocol_error(message.get("error").unwrap_or(&Value::Null)));
            }

            match message.get("method").and_then(Value::as_str) {
                Some("item/tool/call") => {
                    let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                    let name = params.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
                    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    tool_calls += 1;
                    let (content, success) = if tool_calls > MAX_TOOL_ITERATIONS {
                        ("Tool-call limit reached. Answer with the information already collected.".to_string(), false)
                    } else {
                        match run_tool(name.clone(), input).await {
                            Ok(outcome) => {
                                trace.push(outcome.trace);
                                (outcome.content, true)
                            }
                            Err(error) => {
                                trace.push(ToolTrace {
                                    tool: name,
                                    detail: String::new(),
                                    row_count: None,
                                    error: Some(error.message.clone()),
                                });
                                (format!("Error: {}", error.message), false)
                            }
                        }
                    };
                    client
                        .write(&json!({
                            "id": request_id,
                            "result": {
                                "contentItems": [{ "type": "inputText", "text": content }],
                                "success": success,
                            }
                        }))
                        .await?;
                }
                Some("item/completed") => {
                    let item = message.pointer("/params/item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage")
                        && item.get("phase").and_then(Value::as_str) == Some("final_answer")
                    {
                        reply = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                }
                Some("turn/completed") => {
                    let status = message.pointer("/params/turn/status").and_then(Value::as_str);
                    if status != Some("completed") {
                        let detail = message
                            .pointer("/params/turn/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex could not complete this turn.");
                        return Err(internal(detail));
                    }
                    return Ok(AiChatResult { reply, trace });
                }
                Some("error")
                    if !message
                        .pointer("/params/willRetry")
                        .and_then(Value::as_bool)
                        .unwrap_or(false) =>
                {
                    let detail = message
                        .pointer("/params/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex reported an error.");
                    return Err(internal(detail));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| internal("Codex did not finish the answer in time."))?
}

async fn require_account(client: &mut CodexClient) -> Result<(), DbError> {
    let account = client.request("account/read", json!({})).await?;
    if account.get("account").is_some_and(|value| !value.is_null()) {
        Ok(())
    } else {
        Err(internal(
            "Codex is not signed in. Open Settings → AI Assistant and sign in with ChatGPT.",
        ))
    }
}

fn codex_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("CUBBYDB_CODEX_PATH") {
        paths.push(PathBuf::from(path));
    }
    paths.push(PathBuf::from("codex"));
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin/codex"));
        paths.push(PathBuf::from("/usr/local/bin/codex"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin/codex"));
        paths.push(home.join(".npm-global/bin/codex"));
    }
    paths
}

fn open_browser(url: &str) -> Result<(), DbError> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command
        .arg(url)
        .spawn()
        .map_err(|error| internal(format!("Could not open the ChatGPT sign-in page: {error}")))?;
    Ok(())
}

fn parse_codex_version(user_agent: &str) -> Option<String> {
    let (_, suffix) = user_agent.split_once('/')?;
    Some(suffix.split_whitespace().next()?.to_string())
}

fn protocol_error(error: &Value) -> DbError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex app-server rejected the request.");
    internal(message)
}

fn file_error(error: std::io::Error) -> DbError {
    internal(format!("Could not prepare Codex data directory: {error}"))
}

fn internal(message: impl Into<String>) -> DbError {
    DbError::new(DbErrorKind::Internal, message)
}

#[cfg(unix)]
fn restrict_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_version_from_initialize_user_agent() {
        assert_eq!(
            parse_codex_version("Codex Desktop/0.146.0 (Mac OS; arm64)"),
            Some("0.146.0".to_string())
        );
    }
}
