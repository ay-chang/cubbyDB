//! Persistence for saved connections.
//!
//! Connections are stored as a single JSON array in the app's data directory,
//! and on Unix the file is created with `0600` permissions — but passwords
//! themselves live in the OS keychain (`crate::keychain`), not in this file.
//! `upsert`/`set` move whichever form of password a record has (a discrete
//! `password` field, or one embedded in `connection_string`) into the
//! keychain before writing, keyed by the record's own id. A pre-existing
//! plaintext record (saved before this migration) just keeps working as-is —
//! nothing to rehydrate, since its password is still sitting in the JSON —
//! until the next time it's saved, at which point it's moved to the keychain
//! automatically. If the keychain is ever unavailable, the password is left
//! in the JSON rather than lost.
//!
//! `list` deliberately does *not* rehydrate passwords — every OS keychain
//! (macOS in particular) treats each lookup as its own access request,
//! showing its own authorization prompt, so eagerly resolving every saved
//! connection's password just to render a picker list turned "open the app"
//! into a wall of back-to-back password prompts. Only `get` (one specific
//! connection, right before actually connecting to it) rehydrates.

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

    /// Every saved connection's metadata, newest first — passwords are left
    /// blank (see module docs); callers that need one for real, e.g. to
    /// connect, should use `get`. Missing file means an empty list.
    pub fn list(&self) -> Result<Vec<SavedConnection>, DbError> {
        let mut list = self.read_raw()?;
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    /// One saved connection with its real password rehydrated from the
    /// keychain — the only place in this store that touches the keychain for
    /// a *saved* connection, and only for the one actually being used.
    pub fn get(&self, id: &str) -> Result<Option<SavedConnection>, DbError> {
        let list = self.read_raw()?;
        Ok(list.into_iter().find(|c| c.id == id).map(|mut conn| {
            rehydrate_password(&conn.id, &mut conn.params);
            conn
        }))
    }

    fn read_raw(&self) -> Result<Vec<SavedConnection>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))
    }

    /// Insert or update a connection by id, returning the stored record (with
    /// its real password intact — only the on-disk copy has it moved to the
    /// keychain).
    pub fn upsert(&self, mut conn: SavedConnection) -> Result<SavedConnection, DbError> {
        let mut list = self.read_raw()?;
        if conn.id.is_empty() {
            conn.id = new_id();
            conn.created_at = now_millis();
        } else if let Some(existing) = list.iter().find(|c| c.id == conn.id) {
            conn.created_at = existing.created_at;
        }

        let mut to_store = conn.clone();
        move_password_to_keychain(&to_store.id, &mut to_store.params);
        if let Some(existing) = list.iter_mut().find(|c| c.id == to_store.id) {
            *existing = to_store;
        } else {
            list.push(to_store);
        }
        self.write(&list)?;
        Ok(conn)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.read_raw()?;
        list.retain(|c| c.id != id);
        self.write(&list)?;
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
            rehydrate_password(LAST_CONNECTION_ACCOUNT, &mut last.params);
        }
        Ok(last)
    }

    pub fn set(&self, last: &LastConnection) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let mut to_store = last.clone();
        move_password_to_keychain(LAST_CONNECTION_ACCOUNT, &mut to_store.params);
        let json =
            serde_json::to_vec_pretty(&to_store).map_err(|e| DbError::internal(e.to_string()))?;
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

/// Move whichever form of password `params` currently holds (a discrete
/// `password` field, or one embedded in `connection_string`) into the OS
/// keychain under `account`, blanking it in `params` on success. Best-effort:
/// if the keychain write fails, `params` is left untouched so the password
/// stays in the JSON rather than getting lost. When `connection_string` is
/// set, it's the only form `build_config` actually uses (see `db/postgres.rs`),
/// so a discrete `password` alongside it is ignored here too.
fn move_password_to_keychain(account: &str, params: &mut ConnectionParams) {
    let connection_string = params
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    if let Some(cs) = connection_string {
        if let Some((stripped, password)) = extract_dsn_password(cs) {
            if keychain::store_password(account, &password).is_ok() {
                params.connection_string = Some(stripped);
            }
        }
        return;
    }
    if let Some(pw) = params.password.as_deref().filter(|p| !p.is_empty()) {
        if keychain::store_password(account, pw).is_ok() {
            params.password = None;
        }
    }
}

/// Inverse of `move_password_to_keychain`: fill in a password from the
/// keychain if `params` doesn't already have one. A DSN with no password
/// segment is ambiguous — it might have been blanked by migration, or it
/// might genuinely have no password (e.g. trust auth) — so this always tries
/// the keychain lookup and just no-ops if nothing's stored under `account`.
fn rehydrate_password(account: &str, params: &mut ConnectionParams) {
    let connection_string = params
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    if let Some(cs) = connection_string {
        if extract_dsn_password(&cs).is_none() {
            if let Some(pw) = keychain::load_password(account) {
                params.connection_string = Some(insert_dsn_password(&cs, &pw));
            }
        }
        return;
    }
    if params.password.is_none() {
        params.password = keychain::load_password(account);
    }
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
