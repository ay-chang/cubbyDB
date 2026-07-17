//! Query history log.
//!
//! Every executed query is appended as one JSON object per line (JSONL) to
//! `history.jsonl` in the app data directory. Append-only keeps writes cheap and
//! the file greppable; the UI reads the tail to browse and re-run past queries.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "history.jsonl";

/// Once the log grows past this size, it's trimmed back to the most recent
/// `MAX_ENTRIES` lines so it can't grow without bound.
const TRIM_TRIGGER_BYTES: u64 = 1_000_000;
const MAX_ENTRIES: usize = 1000;

/// One executed query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    /// Name of the connection the query ran against, for context in the panel.
    #[serde(default)]
    pub connection_name: Option<String>,
    /// Epoch milliseconds.
    pub executed_at: u64,
    pub success: bool,
    #[serde(default)]
    pub row_count: Option<usize>,
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
    /// Present when `success` is false.
    #[serde(default)]
    pub error: Option<String>,
}

/// Appends to and reads from the history file.
pub struct HistoryStore {
    path: PathBuf,
}

impl HistoryStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    pub fn append(&self, entry: &HistoryEntry) -> Result<(), DbError> {
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

        // Keep the file bounded: once it's large, retain only the newest entries.
        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() > TRIM_TRIGGER_BYTES {
                let _ = self.trim_to_recent();
            }
        }
        Ok(())
    }

    /// Rewrite the file keeping only the most recent `MAX_ENTRIES` lines.
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

    /// Delete all history.
    pub fn clear(&self) -> Result<(), DbError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(e)),
        }
    }

    /// The most recent `limit` entries, newest first. Malformed lines are
    /// skipped rather than failing the whole read.
    pub fn recent(&self, limit: usize) -> Result<Vec<HistoryEntry>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(&self.path).map_err(io_err)?;
        let mut entries: Vec<HistoryEntry> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect();
        entries.reverse();
        entries.truncate(limit);
        Ok(entries)
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(DbErrorKind::Internal, format!("File error: {e}"))
}
