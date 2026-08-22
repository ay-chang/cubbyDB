//! AI audit log — same shape as `history.rs`'s query log, applied to AI
//! turns instead of raw queries: every executed turn is appended as one JSON
//! object per line (JSONL) to `ai_audit.jsonl`, and the UI reads the tail.
//! Append-only for the same reason it's right for `history.rs` — cheap
//! writes, no whole-file rewrite per turn, self-trims instead of growing
//! without bound.
//!
//! Off by default (`AiConfig::audit_log_enabled`) and gated at the call
//! site in `commands::ai_chat`, not here — this module doesn't know or care
//! whether logging is currently enabled, it just records what it's given.
//!
//! Unlike `ToolTrace` (what the chat panel renders — deliberately
//! summarized, so a chat bubble never holds a 50-row dump), an
//! `AuditToolCall` keeps the *full* input and, for tools whose output can't
//! contain a database's actual row content, the full output too. `run_sql`
//! and `sample_rows` are the two tools that can return real row data, so
//! their output is deliberately left out here — `row_count` still shows
//! what happened without persisting what the data actually was.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "ai_audit.jsonl";

/// Same bounding strategy as `history.rs`: once the log grows past this
/// size, it's trimmed back to the most recent `MAX_ENTRIES` lines.
const TRIM_TRIGGER_BYTES: u64 = 5_000_000;
const MAX_ENTRIES: usize = 500;

/// Tools whose output can carry a database's actual row content, and so are
/// never persisted in full here — only that they ran, on what, and how many
/// rows came back. Everything else (`describe_table`, `search_schema`,
/// `explain_query`) returns schema/plan metadata, not data, and is kept in
/// full: it's exactly the context that explains why the model did what it
/// did next.
fn redacts_output(tool: &str) -> bool {
    matches!(tool, "run_sql" | "sample_rows")
}

/// One tool call within a turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditToolCall {
    pub tool: String,
    /// Always kept in full — a table name, a SQL string, a search term.
    /// None of that is the data itself, so it carries no more exposure than
    /// `history.rs`'s own query log already accepts for `run_sql`.
    pub input: Value,
    /// `None` for `run_sql`/`sample_rows` — see `redacts_output`. Present in
    /// full for every other tool.
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub row_count: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

impl AuditToolCall {
    /// Builds a record from a completed tool call. `outcome` is `Ok` with
    /// the tool's raw content/trace, or `Err` with whatever `ai::tools::execute`
    /// returned — recorded either way, since a rejected or failed call is
    /// still part of the record of what the AI attempted.
    pub fn record(
        tool: String,
        input: Value,
        outcome: &Result<crate::ai::tools::ToolOutcome, DbError>,
        elapsed_ms: u64,
    ) -> Self {
        match outcome {
            Ok(result) => Self {
                output: (!redacts_output(&tool)).then(|| result.content.clone()),
                row_count: result.trace.row_count,
                error: None,
                tool,
                input,
                elapsed_ms,
            },
            Err(e) => Self {
                output: None,
                row_count: None,
                error: Some(e.message.clone()),
                tool,
                input,
                elapsed_ms,
            },
        }
    }
}

/// One completed `ai_chat` turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Epoch milliseconds.
    pub started_at: u64,
    pub connection_name: String,
    pub provider: String,
    pub model: String,
    /// Rendered exactly as sent — the whole point of this log over
    /// `ToolTrace` is being able to see the literal context the model had.
    pub system_prompt: String,
    /// The user's message that started this turn (not the whole history —
    /// that's what `ai_chats.json` already keeps).
    pub user_message: String,
    pub tool_calls: Vec<AuditToolCall>,
    /// Empty when the turn failed — see `error`.
    #[serde(default)]
    pub reply: String,
    #[serde(default)]
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// Appends to and reads from the audit log.
pub struct AiAuditStore {
    path: PathBuf,
}

impl AiAuditStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    pub fn append(&self, entry: &AuditEntry) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let mut line =
            serde_json::to_string(entry).map_err(|e| DbError::internal(e.to_string()))?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(io_err)?;
        file.write_all(line.as_bytes()).map_err(io_err)?;
        drop(file);

        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() > TRIM_TRIGGER_BYTES {
                let _ = self.trim_to_recent();
            }
        }
        Ok(())
    }

    fn trim_to_recent(&self) -> Result<(), DbError> {
        let file = fs::File::open(&self.path).map_err(io_err)?;
        let mut lines: Vec<String> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .collect();
        if lines.len() <= MAX_ENTRIES {
            return Ok(());
        }
        let start = lines.len() - MAX_ENTRIES;
        let kept = lines.split_off(start);
        let mut body = kept.join("\n");
        body.push('\n');
        fs::write(&self.path, body).map_err(io_err)?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), DbError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(e)),
        }
    }

    /// The most recent `limit` entries, newest first. Malformed lines are
    /// skipped rather than failing the whole read.
    pub fn recent(&self, limit: usize) -> Result<Vec<AuditEntry>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(&self.path).map_err(io_err)?;
        let mut entries: Vec<AuditEntry> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect();
        entries.reverse();
        entries.truncate(limit);
        Ok(entries)
    }
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(DbErrorKind::Internal, format!("File error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_only_the_two_row_data_tools() {
        assert!(redacts_output("run_sql"));
        assert!(redacts_output("sample_rows"));
        assert!(!redacts_output("describe_table"));
        assert!(!redacts_output("search_schema"));
        assert!(!redacts_output("explain_query"));
    }

    #[test]
    fn append_then_recent_round_trips_newest_first() {
        let dir = std::env::temp_dir().join(format!("cubbydb-audit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = AiAuditStore::new(&dir);
        let _ = store.clear();

        for i in 0..3 {
            store
                .append(&AuditEntry {
                    started_at: i,
                    connection_name: "test".into(),
                    provider: "anthropic".into(),
                    model: "claude".into(),
                    system_prompt: "prompt".into(),
                    user_message: format!("message {i}"),
                    tool_calls: vec![],
                    reply: "reply".into(),
                    error: None,
                    elapsed_ms: 10,
                })
                .unwrap();
        }

        let entries = store.recent(10).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].user_message, "message 2");
        assert_eq!(entries[2].user_message, "message 0");

        store.clear().unwrap();
        assert!(store.recent(10).unwrap().is_empty());
    }
}
