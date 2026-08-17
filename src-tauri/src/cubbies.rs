//! Persistence for cubbies — named, user-curated collections of references
//! to things spread across the app: saved queries, tables, AI chats, and the
//! read-only structure/function/sequence views. Modeled directly on
//! `saved_queries.rs` (same upsert-by-id, JSON-file-per-record-type shape).
//!
//! A cubby stores *references only*, never contents — no copied SQL text, no
//! chat messages, no result rows. Deleting a cubby only deletes the
//! manifest; the saved query, chat, or table it pointed at is untouched.
//! Membership is non-exclusive: the same table or saved query can appear in
//! any number of cubbies at once.
//!
//! Unlike saved queries (deliberately global, reusable across databases),
//! a cubby is scoped to one saved connection — see `connection_id` below —
//! since its other entry kinds (tables, chats) only make sense against a
//! specific database.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "cubbies.json";

/// One thing a cubby points at. Deliberately a reference (ids / names), never
/// a copy of the thing itself, so editing the original — the saved query's
/// SQL, the chat's messages — is instantly reflected everywhere it's
/// referenced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CubbyEntry {
    SavedQuery { saved_query_id: String },
    Table { schema: String, table: String },
    Chat { chat_id: String },
    Structure { schema: String, table: String },
    Function { schema: String, name: String, oid: Option<i64> },
    Sequence { schema: String, name: String },
}

/// A user-created cubby: a named collection of entries, scoped to one saved
/// connection.
///
/// An earlier version also carried a free-text `notes` pad. Removing the
/// field needs no migration: serde ignores unknown fields by default, so an
/// existing `cubbies.json` still loads and simply drops its stale `notes` on
/// the next write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cubby {
    /// Stable id; assigned on first save if empty.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// A *saved* connection's stable id — same reasoning as
    /// `AiChatThread::connection_id` (see `ai/chats.rs`): `session_id`
    /// regenerates every reconnect, so it can't identify "the same
    /// database" across a restart.
    pub connection_id: String,
    #[serde(default)]
    pub entries: Vec<CubbyEntry>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// Reads and writes the cubbies file.
pub struct CubbyStore {
    path: PathBuf,
}

impl CubbyStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// All cubbies, newest-updated first. Missing file means an empty list.
    /// Global rather than filtered by connection here — the frontend filters
    /// to the active connection, same division of labor as `SavedQueryStore`.
    pub fn list(&self) -> Result<Vec<Cubby>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        let mut list: Vec<Cubby> =
            serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))?;
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list)
    }

    /// Insert or update a cubby by id, returning the stored record.
    pub fn upsert(&self, mut cubby: Cubby) -> Result<Cubby, DbError> {
        let mut list = self.list()?;
        let now = now_millis();
        if cubby.id.is_empty() {
            cubby.id = new_id();
            cubby.created_at = now;
        } else if let Some(existing) = list.iter().find(|c| c.id == cubby.id) {
            cubby.created_at = existing.created_at;
        }
        cubby.updated_at = now;

        if let Some(existing) = list.iter_mut().find(|c| c.id == cubby.id) {
            *existing = cubby.clone();
        } else {
            list.push(cubby.clone());
        }
        self.write(&list)?;
        Ok(cubby)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.list()?;
        list.retain(|c| c.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[Cubby]) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json =
            serde_json::to_vec_pretty(list).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(DbErrorKind::Internal, format!("File error: {e}"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("cubby_{nanos}")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
