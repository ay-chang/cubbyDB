//! Persistence for saved queries — named, explicitly-saved SQL consoles the
//! user can browse and reopen later.
//!
//! Deliberately separate from two other things that might look similar:
//! `history.rs` is an automatic, unnamed, append-only log of every query run
//! (no id, no upsert/delete-one, self-trimming); the "restore tabs on
//! launch" mechanism (`src/state/store.ts`) is frontend-`localStorage`-only
//! and just reopens whatever happened to be open, un-curated. This is the
//! explicit, named, user-curated concept — modeled directly on
//! `ConnectionStore` in `connections.rs`, minus the keychain step since a
//! saved query has no secret to protect.
//!
//! Global, not tied to a connection: a saved query is often meant to be
//! reused across databases with the same shape (e.g. staging vs prod), same
//! as the Cmd+K quick-jump palette searching across every open connection.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "saved_queries.json";

/// A user-saved query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    /// Stable id; assigned on first save if empty.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub sql: String,
    /// Epoch milliseconds of creation.
    #[serde(default)]
    pub created_at: u64,
}

/// Reads and writes the saved-queries file.
pub struct SavedQueryStore {
    path: PathBuf,
}

impl SavedQueryStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// All saved queries, newest first. Missing file means an empty list.
    pub fn list(&self) -> Result<Vec<SavedQuery>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        let mut list: Vec<SavedQuery> =
            serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))?;
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    /// Insert or update a query by id, returning the stored record.
    pub fn upsert(&self, mut query: SavedQuery) -> Result<SavedQuery, DbError> {
        let mut list = self.list()?;
        if query.id.is_empty() {
            query.id = new_id();
            query.created_at = now_millis();
        } else if let Some(existing) = list.iter().find(|q| q.id == query.id) {
            query.created_at = existing.created_at;
        }

        if let Some(existing) = list.iter_mut().find(|q| q.id == query.id) {
            *existing = query.clone();
        } else {
            list.push(query.clone());
        }
        self.write(&list)?;
        Ok(query)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.list()?;
        list.retain(|q| q.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[SavedQuery]) -> Result<(), DbError> {
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
    // Monotonic-enough id for local records: nanoseconds since the epoch.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("query_{nanos}")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
