//! Trust-on-first-use store for SSH bastion host keys.
//!
//! A tunneled connection has to verify the bastion's identity somehow — the
//! standard answer is trust-on-first-use: the first time a host key is seen
//! it's shown to the user for confirmation, and every connection after that
//! is checked against what was confirmed. This file is exactly that record,
//! one entry per (host, port), holding the fingerprint that was confirmed
//! and when.
//!
//! Same plaintext-JSON pattern as `connections.rs`/`saved_queries.rs` — a
//! fingerprint isn't a secret (unlike a password or private key), so there's
//! no separate case to make for this file specifically.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "ssh_known_hosts.json";

/// One bastion's host key, as confirmed by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHostKey {
    pub host: String,
    pub port: u16,
    /// `"SHA256:<base64>"`, matching the format `ssh-keygen -l` prints —
    /// familiar to anyone comparing it against what their own terminal shows.
    pub key_fingerprint: String,
    /// Epoch milliseconds when this fingerprint was confirmed.
    pub accepted_at: u64,
}

/// Reads and writes the trusted-host-key file.
pub struct SshKnownHostsStore {
    path: PathBuf,
}

impl SshKnownHostsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// The trusted fingerprint for `(host, port)`, if any has been confirmed.
    /// `None` — not an error — means this bastion has never been trusted;
    /// the caller (the TOFU handler, or the probe command) decides what that
    /// means for whatever it's doing.
    pub fn lookup(&self, host: &str, port: u16) -> Result<Option<TrustedHostKey>, DbError> {
        let list = self.read_raw()?;
        Ok(list.into_iter().find(|k| k.host == host && k.port == port))
    }

    /// Records `fingerprint` as trusted for `(host, port)`, replacing
    /// whatever was trusted for it before — the caller (`trust_ssh_host_key`)
    /// is the only place this is ever invoked from, itself only reachable
    /// after the frontend's own confirmation UI, so overwriting here is
    /// always the user's own explicit re-verification of a changed key, not
    /// something happening silently underneath them.
    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), DbError> {
        let mut list = self.read_raw()?;
        list.retain(|k| !(k.host == host && k.port == port));
        list.push(TrustedHostKey {
            host: host.to_string(),
            port,
            key_fingerprint: fingerprint.to_string(),
            accepted_at: now_millis(),
        });
        self.write(&list)
    }

    fn read_raw(&self) -> Result<Vec<TrustedHostKey>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))
    }

    fn write(&self, list: &[TrustedHostKey]) -> Result<(), DbError> {
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

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
