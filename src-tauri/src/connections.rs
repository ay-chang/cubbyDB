//! Persistence for saved connections.
//!
//! Connections — including their passwords — are stored in plaintext as a
//! single JSON array in the app's data directory; on Unix the file is
//! created with `0600` permissions as the only real protection. An earlier
//! version of this app moved passwords into the OS keychain instead, but
//! every OS keychain (macOS in particular) treats each lookup *and* each
//! store as its own access request with its own authorization prompt —
//! connecting to a saved database, or just restarting the app, could mean
//! two or three separate password prompts in a row. That trade wasn't worth
//! it, so this version doesn't touch the keychain for anything new.
//!
//! For anyone upgrading from that version: `pull_back_from_keychain` is a
//! one-time migration, run the first time each saved (or last-used)
//! connection is read here — it pulls the password back out of the keychain
//! into this plaintext file and deletes the keychain entry, so after that
//! first read the keychain is never touched again for that connection.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{ConnectionParams, DbError, DbErrorKind, Engine};
use crate::keychain;

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

    /// Every saved connection, newest first, real passwords included —
    /// there's no ongoing cost to that now everything lives in plaintext (see
    /// module docs). Missing file means an empty list.
    pub fn list(&self) -> Result<Vec<SavedConnection>, DbError> {
        let mut list = self.read_raw()?;
        let mut dirty = false;
        for conn in &mut list {
            if pull_back_from_keychain(&conn.id, &mut conn.params) {
                dirty = true;
            }
        }
        if dirty {
            self.write(&list)?;
        }
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    fn read_raw(&self) -> Result<Vec<SavedConnection>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))
    }

    /// Insert or update a connection by id, returning the stored record.
    pub fn upsert(&self, mut conn: SavedConnection) -> Result<SavedConnection, DbError> {
        let mut list = self.read_raw()?;
        if conn.id.is_empty() {
            conn.id = new_id();
            conn.created_at = now_millis();
        } else if let Some(existing) = list.iter().find(|c| c.id == conn.id) {
            conn.created_at = existing.created_at;
        }

        if let Some(existing) = list.iter_mut().find(|c| c.id == conn.id) {
            *existing = conn.clone();
        } else {
            list.push(conn.clone());
        }
        self.write(&list)?;
        Ok(conn)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.read_raw()?;
        list.retain(|c| c.id != id);
        self.write(&list)?;
        // Best-effort cleanup in case this record was never read (and thus
        // never migrated) since upgrading off keychain storage.
        keychain::delete_password(id);
        Ok(())
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
        let mut last: Option<LastConnection> = serde_json::from_slice(&bytes).ok();
        if let Some(last) = &mut last {
            if pull_back_from_keychain(LAST_CONNECTION_ACCOUNT, &mut last.params) {
                self.set(last)?;
            }
        }
        Ok(last)
    }

    pub fn set(&self, last: &LastConnection) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json =
            serde_json::to_vec_pretty(last).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }

    pub fn clear(&self) -> Result<(), DbError> {
        keychain::delete_password(LAST_CONNECTION_ACCOUNT);
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(e)),
        }
    }
}

/// Fixed account key for `LastConnectionStore`, which is a singleton with no
/// id of its own.
const LAST_CONNECTION_ACCOUNT: &str = "__last_connection__";

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

/// One-time migration off the OS keychain (see module docs): if `params` has
/// no password but one is still sitting in the keychain under `account` from
/// a previous version of this app, pulls it into `params` in plaintext and
/// deletes the keychain entry — so this is the *last* time that account is
/// ever looked up. Returns `true` if anything was actually pulled back, so
/// callers know whether the record needs to be re-persisted to disk. A DSN
/// with no password segment is ambiguous — it might be pre-migration, or it
/// might genuinely have no password (e.g. trust auth) — so this always tries
/// the keychain lookup and just no-ops if nothing's stored under `account`.
fn pull_back_from_keychain(account: &str, params: &mut ConnectionParams) -> bool {
    let connection_string = params
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    if let Some(cs) = connection_string {
        if extract_dsn_password(&cs).is_none() {
            if let Some(pw) = keychain::load_password(account) {
                params.connection_string = Some(insert_dsn_password(&cs, &pw));
                keychain::delete_password(account);
                return true;
            }
        }
        return false;
    }
    if params.password.is_none() {
        if let Some(pw) = keychain::load_password(account) {
            params.password = Some(pw);
            keychain::delete_password(account);
            return true;
        }
    }
    false
}

/// If `dsn` has a `scheme://user:password@...` userinfo segment, returns
/// `(dsn-with-the-password-blanked, password)`. Returns `None` when there's
/// nothing to extract — no `://`, no `@` before the path, no `:` in the
/// userinfo segment, or an already-empty password — so callers can treat
/// `None` as "leave it alone."
fn extract_dsn_password(dsn: &str) -> Option<(String, String)> {
    let scheme_end = dsn.find("://")? + 3;
    let rest = &dsn[scheme_end..];
    let at = rest.find('@')?;
    if let Some(slash) = rest.find('/') {
        if slash < at {
            return None;
        }
    }
    let creds = &rest[..at];
    let colon = creds.find(':')?;
    let password = &creds[colon + 1..];
    if password.is_empty() {
        return None;
    }
    let user = &creds[..colon];
    let stripped = format!("{}{user}{}", &dsn[..scheme_end], &rest[at..]);
    Some((stripped, password.to_string()))
}

/// Inverse of `extract_dsn_password`: re-insert `password` into a DSN whose
/// userinfo segment has no password (`scheme://user@...`). A no-op — returns
/// `dsn` unchanged — if there's no `user@` segment to attach it to, or it
/// already has one.
fn insert_dsn_password(dsn: &str, password: &str) -> String {
    let Some(scheme_end) = dsn.find("://").map(|i| i + 3) else {
        return dsn.to_string();
    };
    let rest = &dsn[scheme_end..];
    let Some(at) = rest.find('@') else {
        return dsn.to_string();
    };
    if let Some(slash) = rest.find('/') {
        if slash < at {
            return dsn.to_string();
        }
    }
    let creds = &rest[..at];
    if creds.is_empty() || creds.contains(':') {
        return dsn.to_string();
    }
    format!("{}{creds}:{password}{}", &dsn[..scheme_end], &rest[at..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_password_from_neon_style_dsn() {
        let dsn = "postgresql://neondb_owner:abc123@ep-quiet-silence-1.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
        let (stripped, password) = extract_dsn_password(dsn).expect("password present");
        assert_eq!(password, "abc123");
        assert_eq!(
            stripped,
            "postgresql://neondb_owner@ep-quiet-silence-1.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
        );
    }

    #[test]
    fn extract_round_trips_through_insert() {
        // A password containing an extra colon exercises the "split on the
        // first colon only" rule in `extract_dsn_password`.
        let dsn = "postgres://user:pa:ss:w0rd@host:5432/db?sslmode=require";
        let (stripped, password) = extract_dsn_password(dsn).expect("password present");
        assert_eq!(password, "pa:ss:w0rd");
        assert_eq!(insert_dsn_password(&stripped, &password), dsn);
    }

    #[test]
    fn no_password_present_returns_none() {
        assert!(extract_dsn_password("postgresql://user@host/db").is_none());
    }

    #[test]
    fn no_credentials_at_all_returns_none() {
        assert!(extract_dsn_password("postgresql://host/db").is_none());
    }

    #[test]
    fn empty_password_returns_none() {
        assert!(extract_dsn_password("postgresql://user:@host/db").is_none());
    }

    #[test]
    fn insert_is_noop_without_user_segment() {
        let dsn = "postgresql://host/db";
        assert_eq!(insert_dsn_password(dsn, "secret"), dsn);
    }

    #[test]
    fn insert_is_noop_when_password_already_present() {
        let dsn = "postgresql://user:existing@host/db";
        assert_eq!(insert_dsn_password(dsn, "secret"), dsn);
    }
}
