//! Claude Code CLI integration for Claude subscription access via OAuth.
//!
//! CubbyDB never reads or copies Claude Code's OAuth credentials. The
//! official `claude` CLI owns the browser login round-trip and credential
//! storage/refresh — CubbyDB just shells out to it, exactly as it does for
//! Codex (see `codex.rs`) and exactly what t3code does (see its
//! `docs/user/providers-claude.md`): an existing `claude auth login` is
//! immediately available, and CubbyDB's own login button just runs that
//! same command.
//!
//! Unlike Codex, `claude` has no bidirectional JSON-RPC app-server for tool
//! calls: its non-interactive mode (`claude -p`) is one-shot — send a
//! prompt, get a `result` back, no way to stream tool results back over
//! stdin. To still let the model call CubbyDB's read-only database tools,
//! `run_loop` stands up a tiny MCP server on a random loopback port for the
//! duration of a single turn and points `claude -p` at it with
//! `--mcp-config`/`--strict-mcp-config`, while `--tools ""` disables every
//! built-in tool (Bash, Read, Write, WebSearch, …) so the database tools are
//! the only capability available. The bridge is torn down the moment the
//! turn finishes. This design was verified against the real CLI (protocol
//! version, session header, request/response shapes) before being written
//! here, not guessed from documentation.

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::time::timeout;

use super::tools::{tool_definitions, ToolOutcome};
use super::{AiChatResult, ChatMessage, ModelInfo, ReasoningEffort, ToolTrace, MAX_TOOL_ITERATIONS};
use crate::db::{DbError, DbErrorKind};

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGIN_GRACE_PERIOD: Duration = Duration::from_secs(3);
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Mirrors the shape of `claude auth status --json`. Every field is
/// optional/defaulted — an older or newer CLI version changing this shape
/// should degrade to "unknown" rather than fail the whole probe.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusJson {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    subscription_type: Option<String>,
}

/// Mirrors the top-level object `claude -p --output-format json` prints
/// once, at the end, when the turn completes.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTurnResult {
    #[serde(default)]
    subtype: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
}

enum SpawnError {
    NotFound,
    Other(String),
}

fn to_db_error(error: SpawnError) -> DbError {
    match error {
        SpawnError::NotFound => internal(
            "Claude Code CLI is not installed or could not be found. Install it from \
             https://claude.com/claude-code, then return to Settings.",
        ),
        SpawnError::Other(message) => internal(message),
    }
}

pub async fn status() -> ClaudeCodeStatus {
    let version = match run_claude_capture(&["--version"]).await {
        Ok(output) => parse_version(&String::from_utf8_lossy(&output.stdout)),
        Err(SpawnError::NotFound) => {
            return ClaudeCodeStatus {
                installed: false,
                error: Some(
                    "Claude Code CLI (`claude`) is not installed or not on PATH.".to_string(),
                ),
                ..ClaudeCodeStatus::default()
            };
        }
        Err(SpawnError::Other(message)) => {
            return ClaudeCodeStatus {
                installed: true,
                error: Some(message),
                ..ClaudeCodeStatus::default()
            };
        }
    };

    let auth_output = match run_claude_capture(&["auth", "status", "--json"]).await {
        Ok(output) => output,
        Err(SpawnError::NotFound) => {
            return ClaudeCodeStatus {
                installed: false,
                version,
                error: Some(
                    "Claude Code CLI (`claude`) is not installed or not on PATH.".to_string(),
                ),
                ..ClaudeCodeStatus::default()
            };
        }
        Err(SpawnError::Other(message)) => {
            return ClaudeCodeStatus {
                installed: true,
                version,
                error: Some(message),
                ..ClaudeCodeStatus::default()
            };
        }
    };

    match serde_json::from_slice::<AuthStatusJson>(&auth_output.stdout) {
        Ok(auth) if auth.logged_in => ClaudeCodeStatus {
            installed: true,
            authenticated: true,
            email: auth.email,
            plan_type: auth.subscription_type,
            version,
            error: None,
        },
        Ok(_) => ClaudeCodeStatus {
            installed: true,
            version,
            ..ClaudeCodeStatus::default()
        },
        Err(_) => ClaudeCodeStatus {
            installed: true,
            version,
            error: Some("Could not read Claude Code's authentication status.".to_string()),
            ..ClaudeCodeStatus::default()
        },
    }
}

/// Starts Claude Code's own OAuth login flow (`claude auth login`). The CLI
/// owns the browser round-trip and credential storage; CubbyDB never sees a
/// token, and this returns before the flow completes — Settings polls
/// `status()` afterward to notice completion, the same UX Codex's login
/// button uses.
///
/// Unlike Codex's app-server, there is no JSON-RPC "login completed" event
/// to await here, and it isn't fully confirmed that `claude auth login`
/// tolerates running with piped (non-TTY) stdio — so this waits out a short
/// grace period first: if the process exits (unhappily) within it, that
/// almost certainly means it refused to run non-interactively, and the
/// failure is surfaced immediately instead of leaving Settings polling a
/// login that already died.
pub async fn start_login() -> Result<(), DbError> {
    let mut child = spawn_claude(&["auth", "login", "--claudeai"], None, |cmd| {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
    })
    .map_err(to_db_error)?;

    match timeout(LOGIN_GRACE_PERIOD, child.wait()).await {
        Ok(Ok(exit_status)) if !exit_status.success() => {
            let mut stderr_text = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr_text).await;
            }
            Err(internal(if stderr_text.trim().is_empty() {
                "Claude Code login exited immediately. Run `claude auth login` in a terminal \
                 instead."
                    .to_string()
            } else {
                stderr_text.trim().to_string()
            }))
        }
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(internal(format!("Could not run Claude Code login: {error}"))),
        Err(_) => {
            // Still running past the grace window: it's waiting on the
            // browser. Let it keep going in the background.
            tokio::spawn(async move {
                let _ = timeout(LOGIN_TIMEOUT, child.wait()).await;
            });
            Ok(())
        }
    }
}

/// Signs out of the Claude Code CLI's current account (`claude auth
/// logout`). The CLI owns removing its own stored credential; CubbyDB never
/// held one to begin with.
pub async fn logout() -> Result<(), DbError> {
    let output = run_claude_capture(&["auth", "logout"])
        .await
        .map_err(to_db_error)?;
    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        return Err(internal(if stderr_text.trim().is_empty() {
            "Claude Code logout failed.".to_string()
        } else {
            stderr_text.trim().to_string()
        }));
    }
    Ok(())
}

/// A fixed list: unlike Codex's `model/list`, the `claude` CLI has no
/// command that enumerates models a subscription can use. These are the
/// model aliases `--model` and `--effort` document today; if Anthropic
/// changes the lineup this list needs a manual update. Every model is
/// marked as supporting `--effort` since the CLI documents it as a global
/// flag, not a per-model capability — unverified against every model here,
/// but consistent with the CLI's own documentation.
pub fn list_models() -> Vec<ModelInfo> {
    let efforts = vec![
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ];
    [
        ("claude-opus-5", "Claude Opus 5"),
        ("claude-sonnet-5", "Claude Sonnet 5"),
        ("claude-fable-5", "Claude Fable 5"),
        ("claude-haiku-4-5", "Claude Haiku 4.5"),
    ]
    .into_iter()
    .map(|(id, label)| ModelInfo {
        id: id.to_string(),
        label: label.to_string(),
        supports_effort: true,
        supported_reasoning_efforts: efforts.clone(),
        default_reasoning_effort: Some(ReasoningEffort::Medium),
    })
    .collect()
}

/// Runs one user turn to completion via `claude -p`.
///
/// `run_tool` is supplied by `commands::ai_chat`, same contract as the other
/// three providers' loops: it owns the session lock and the reconnect-on-drop
/// retry, and this module has no business knowing about either.
pub async fn run_loop<F, Fut>(
    data_dir: &Path,
    model: &str,
    reasoning_effort: ReasoningEffort,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    run_tool: F,
) -> Result<AiChatResult, DbError>
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<ToolOutcome, DbError>>,
{
    let workspace = data_dir.join("claude-code-workspace");
    std::fs::create_dir_all(&workspace).map_err(file_error)?;
    restrict_directory(&workspace);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| internal(format!("Could not open a local port for Claude Code's tools: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| internal(format!("Could not read the local port: {e}")))?
        .port();
    let token = random_token();

    let mcp_config = json!({
        "mcpServers": {
            "cubbydb": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    })
    .to_string();

    let instructions = format!(
        "{system_prompt}\n\nYou are running inside CubbyDB, not a coding workspace. Your only \
         permitted capability is the `cubbydb` MCP server's read-only database tools. Never use \
         Bash, filesystem, web search, or any other tool. Do not ask for approval. If a \
         capability is not one of the supplied tools, it is unavailable."
    );

    // Codex gets the whole conversation as one `turn/start` input array
    // (see codex.rs) because each `ai_chat` call re-derives the answer fresh
    // from the plain history the frontend sent, never resuming a live
    // session — `claude -p`'s one-shot prompt fits that exact same shape.
    let transcript = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "Assistant" } else { "User" };
            format!("{role}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let effort = reasoning_effort.as_str();
    let mut child = spawn_claude(
        &[
            "-p",
            "--output-format",
            "json",
            "--model",
            model,
            "--effort",
            effort,
            "--system-prompt",
            &instructions,
            "--tools",
            "",
            "--mcp-config",
            &mcp_config,
            "--strict-mcp-config",
            "--permission-mode",
            "bypassPermissions",
            "--no-session-persistence",
        ],
        Some(&workspace),
        |cmd| {
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        },
    )
    .map_err(to_db_error)?;

    // Feed the flattened transcript over stdin and close it so Claude Code
    // knows input is complete — `-p` reads its prompt from stdin when none
    // is given as an argument, which also sidesteps the OS argv length limit
    // a long conversation could otherwise hit.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(transcript.as_bytes())
            .await
            .map_err(|e| internal(format!("Could not send the prompt to Claude Code: {e}")))?;
        // Dropping `stdin` here closes the write half so `claude` sees EOF.
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| internal("Claude Code stdout was unavailable."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| internal("Claude Code stderr was unavailable."))?;

    let collect_output = async move {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_result, err_result) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        out_result?;
        err_result?;
        Ok::<(Vec<u8>, Vec<u8>), std::io::Error>((out, err))
    };
    tokio::pin!(collect_output);

    let mut trace = Vec::new();
    let mut tool_calls = 0_u32;

    let loop_future = async {
        loop {
            tokio::select! {
                result = &mut collect_output => break result,
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        handle_mcp_request(stream, &token, &run_tool, &mut trace, &mut tool_calls).await;
                    }
                }
            }
        }
    };

    let final_output = match timeout(TURN_TIMEOUT, loop_future).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.start_kill();
            return Err(internal("Claude Code did not finish the answer in time."));
        }
    };
    let (stdout_bytes, stderr_bytes) =
        final_output.map_err(|e| internal(format!("Could not read Claude Code's output: {e}")))?;

    let exit_status = child
        .wait()
        .await
        .map_err(|e| internal(format!("Claude Code exited unexpectedly: {e}")))?;

    if !exit_status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr_bytes);
        return Err(internal(if stderr_text.trim().is_empty() {
            "Claude Code exited with an error.".to_string()
        } else {
            stderr_text.trim().to_string()
        }));
    }

    let parsed: ClaudeTurnResult = serde_json::from_slice(&stdout_bytes)
        .map_err(|e| internal(format!("Could not parse Claude Code's response: {e}")))?;

    if parsed.is_error || parsed.subtype != "success" {
        return Err(internal(parsed.result.unwrap_or_else(|| {
            "Claude Code could not complete this turn.".to_string()
        })));
    }

    Ok(AiChatResult {
        reply: parsed.result.unwrap_or_default(),
        trace,
    })
}

// --- Loopback MCP bridge -----------------------------------------------------
//
// A minimal hand-rolled HTTP/1.1 responder, not a general-purpose server: it
// serves exactly one JSON-RPC message per TCP connection (`claude`'s MCP
// client reconnects for each call rather than pipelining, confirmed by
// watching it live against a throwaway test server), bound to loopback only,
// gated by a random per-turn bearer token, and torn down the instant the
// turn ends. That scope is what keeps hand-rolling this simpler and more
// auditable than pulling in an HTTP server crate for a bridge that lives for
// the duration of a single chat turn.

struct HttpRequest {
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut reader = BufReader::new(&mut *stream);

    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let content_length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);

    let body = if content_length > 0 {
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf).await?;
        Some(buf)
    } else {
        None
    };

    Ok(HttpRequest {
        method,
        headers,
        body,
    })
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: Option<&Value>,
    extra_headers: &[(&str, String)],
) -> std::io::Result<()> {
    let body_bytes = body
        .map(|v| serde_json::to_vec(v).unwrap_or_default())
        .unwrap_or_default();
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body_bytes.len()
    );
    for (key, value) in extra_headers {
        response.push_str(&format!("{key}: {value}\r\n"));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    if !body_bytes.is_empty() {
        stream.write_all(&body_bytes).await?;
    }
    stream.flush().await
}

async fn handle_mcp_request<F, Fut>(
    mut stream: TcpStream,
    token: &str,
    run_tool: &F,
    trace: &mut Vec<ToolTrace>,
    tool_calls: &mut u32,
) where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<ToolOutcome, DbError>>,
{
    let request = match read_http_request(&mut stream).await {
        Ok(request) => request,
        Err(_) => return,
    };

    // The Streamable HTTP transport lets a client open a GET for a
    // server-push SSE stream. This bridge only ever answers requests
    // synchronously and never pushes anything unprompted, so it declines —
    // `claude` tolerates this fine and just doesn't use server push.
    if request.method == "GET" {
        let _ = write_http_response(&mut stream, 405, "Method Not Allowed", None, &[]).await;
        return;
    }

    if request.header("authorization") != Some(&format!("Bearer {token}")) {
        let _ = write_http_response(&mut stream, 401, "Unauthorized", None, &[]).await;
        return;
    }

    let Some(body) = request.body else {
        // A bodyless POST is a notification-shaped ping; nothing to do.
        let _ = write_http_response(&mut stream, 202, "Accepted", None, &[]).await;
        return;
    };

    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        let _ = write_http_response(&mut stream, 400, "Bad Request", None, &[]).await;
        return;
    };

    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let id = message.get("id").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let protocol_version = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION);
            let result = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "cubbydb", "version": env!("CARGO_PKG_VERSION") },
                }
            });
            let _ = write_http_response(
                &mut stream,
                200,
                "OK",
                Some(&result),
                &[("Mcp-Session-Id", random_token())],
            )
            .await;
        }
        "notifications/initialized" | "notifications/cancelled" => {
            let _ = write_http_response(&mut stream, 202, "Accepted", None, &[]).await;
        }
        "tools/list" => {
            let tools = tool_definitions()
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|tool| {
                    json!({
                        "name": tool.get("name").cloned().unwrap_or(Value::Null),
                        "description": tool.get("description").cloned().unwrap_or(Value::Null),
                        "inputSchema": tool.get("input_schema").cloned().unwrap_or_else(|| json!({})),
                    })
                })
                .collect::<Vec<_>>();
            let result = json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } });
            let _ = write_http_response(&mut stream, 200, "OK", Some(&result), &[]).await;
        }
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));

            *tool_calls += 1;
            let (text, is_error) = if *tool_calls > MAX_TOOL_ITERATIONS {
                (
                    "Tool-call limit reached. Answer with the information already collected."
                        .to_string(),
                    true,
                )
            } else {
                match run_tool(name.clone(), arguments).await {
                    Ok(outcome) => {
                        trace.push(outcome.trace);
                        (outcome.content, false)
                    }
                    Err(error) => {
                        trace.push(ToolTrace {
                            tool: name,
                            detail: String::new(),
                            row_count: None,
                            error: Some(error.message.clone()),
                        });
                        (format!("Error: {}", error.message), true)
                    }
                }
            };

            let result = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": text }], "isError": is_error }
            });
            let _ = write_http_response(&mut stream, 200, "OK", Some(&result), &[]).await;
        }
        _ => {
            let error = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            });
            let _ = write_http_response(&mut stream, 404, "Not Found", Some(&error), &[]).await;
        }
    }
}

// --- Process spawning ---------------------------------------------------------

fn claude_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("CUBBYDB_CLAUDE_PATH") {
        paths.push(PathBuf::from(path));
    }
    paths.push(PathBuf::from("claude"));
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
        paths.push(PathBuf::from("/usr/local/bin/claude"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin/claude"));
        paths.push(home.join(".npm-global/bin/claude"));
    }
    paths
}

fn spawn_claude(
    args: &[&str],
    cwd: Option<&Path>,
    configure: impl Fn(&mut Command),
) -> Result<Child, SpawnError> {
    let mut last_not_found = false;
    for binary in claude_candidates() {
        let mut command = Command::new(&binary);
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        configure(&mut command);
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                last_not_found = true;
            }
            Err(error) => {
                return Err(SpawnError::Other(format!(
                    "Could not start Claude Code CLI: {error}"
                )));
            }
        }
    }
    if last_not_found {
        Err(SpawnError::NotFound)
    } else {
        Err(SpawnError::Other(
            "Could not start Claude Code CLI.".to_string(),
        ))
    }
}

async fn run_claude_capture(args: &[&str]) -> Result<std::process::Output, SpawnError> {
    let child = spawn_claude(args, None, |cmd| {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    })?;
    match timeout(STATUS_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(SpawnError::Other(format!(
            "Claude Code CLI failed: {error}"
        ))),
        Err(_) => Err(SpawnError::Other(
            "Claude Code CLI did not respond in time.".to_string(),
        )),
    }
}

fn parse_version(version_output: &str) -> Option<String> {
    let trimmed = version_output.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.split_whitespace().next().map(str::to_string)
}

/// A per-turn random token/session id — good enough to keep other local
/// processes from guessing their way onto a loopback port that lives for
/// only as long as one chat turn. `RandomState`'s keys are seeded from the
/// OS on every construction, so hashing a fixed input with two independent
/// instances gives an unpredictable value without pulling in a `rand`
/// dependency just for this.
fn random_token() -> String {
    let mut a = RandomState::new().build_hasher();
    let mut b = RandomState::new().build_hasher();
    a.write_u64(0);
    b.write_u64(1);
    format!("{:016x}{:016x}", a.finish(), b.finish())
}

fn internal(message: impl Into<String>) -> DbError {
    DbError::new(DbErrorKind::Internal, message)
}

fn file_error(error: std::io::Error) -> DbError {
    internal(format!(
        "Could not prepare Claude Code's data directory: {error}"
    ))
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
    fn extracts_leading_token_as_version() {
        assert_eq!(
            parse_version("2.1.212 (Claude Code)\n"),
            Some("2.1.212".to_string())
        );
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn random_tokens_are_not_trivially_predictable() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
    }

    /// Live smoke test against the real `claude` CLI and a real subscription
    /// turn — not run in normal `cargo test` (needs `claude` installed and
    /// logged in, and spends real usage). Run manually with
    /// `cargo test --lib ai::claude_code::tests::live_run_loop_calls_the_bridged_tool -- --ignored --nocapture`
    /// to verify the MCP bridge end to end after touching this file.
    #[tokio::test]
    #[ignore]
    async fn live_run_loop_calls_the_bridged_tool() {
        let data_dir = std::env::temp_dir().join("cubbydb-claude-code-live-test");
        let result = run_loop(
            &data_dir,
            DEFAULT_MODEL,
            ReasoningEffort::Medium,
            "You are a terse test assistant.".to_string(),
            vec![ChatMessage {
                role: "user".to_string(),
                content: "Call the run_sql tool with sql set to 'SELECT 1', then reply with \
                          exactly the tool's raw text output and nothing else."
                    .to_string(),
                trace: None,
            }],
            |name, input| async move {
                assert_eq!(name, "run_sql");
                Ok(ToolOutcome {
                    content: "cubbydb-live-test-ok".to_string(),
                    trace: ToolTrace {
                        tool: name,
                        detail: input.to_string(),
                        row_count: Some(1),
                        error: None,
                    },
                })
            },
        )
        .await
        .expect("run_loop should succeed");

        assert!(
            result.reply.contains("cubbydb-live-test-ok"),
            "unexpected reply: {}",
            result.reply
        );
        assert_eq!(result.trace.len(), 1);
        assert_eq!(result.trace[0].tool, "run_sql");
    }
}
