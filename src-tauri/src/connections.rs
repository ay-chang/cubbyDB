//! Persistence for saved connections.
//!
//! Connections are stored as a single JSON array in the app's data directory.
//! On Unix the file is created with `0600` permissions. Passwords are stored in
//! plaintext for v1 (see README — moving secrets to the OS keychain is planned);
//! everything here is on the user's own machine and never leaves it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{ConnectionParams, DbError, DbErrorKind, Engine};

const FILE_NAME: &str = "connections.json";
const LAST_FILE_NAME: &str = "last_connection.json";

/// A user-saved connection record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    /// Stable id; assigned on first save if empty.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub engine: Engine,
    pub params: ConnectionParams,
    /// Epoch milliseconds of creation.
    #[serde(default)]
    pub created_at: u64,
}

/// Reads and writes the saved-connection file.
pub struct ConnectionStore {
    path: PathBuf,
}

impl ConnectionStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// All saved connections, newest first. Missing file means an empty list.
    pub fn list(&self) -> Result<Vec<SavedConnection>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        let mut list: Vec<SavedConnection> =
            serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))?;
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    /// Insert or update a connection by id, returning the stored record.
    pub fn upsert(&self, mut conn: SavedConnection) -> Result<SavedConnection, DbError> {
        let mut list = self.list()?;
        if conn.id.is_empty() {
            conn.id = new_id();
            conn.created_at = now_millis();
            list.push(conn.clone());
        } else if let Some(existing) = list.iter_mut().find(|c| c.id == conn.id) {
            conn.created_at = existing.created_at;
            *existing = conn.clone();
        } else {
            list.push(conn.clone());
        }
        self.write(&list)?;
        Ok(conn)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.list()?;
        list.retain(|c| c.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[SavedConnection]) -> Result<(), DbError> {
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

/// The most recently connected database, remembered so the app can reconnect
/// automatically on the next launch instead of asking again. A live session
/// can't survive a restart, but its parameters can.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastConnection {
    pub name: String,
    #[serde(default)]
    pub engine: Engine,
    pub params: ConnectionParams,
}

/// Reads/writes the single "last connection" record.
pub struct LastConnectionStore {
    path: PathBuf,
}

impl LastConnectionStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(LAST_FILE_NAME),
        }
    }

    pub fn get(&self) -> Result<Option<LastConnection>, DbError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        // A corrupt file shouldn't wedge startup — treat it as "no last".
        Ok(serde_json::from_slice(&bytes).ok())
    }

    pub fn set(&self, last: &LastConnection) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json = serde_json::to_vec_pretty(last).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }

    pub fn clear(&self) -> Result<(), DbError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(e)),
        }
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
    format!("conn_{nanos}")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
