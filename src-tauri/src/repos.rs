//! Persistence for code repositories attached to a connection, so the AI
//! assistant can read how the application actually uses the database rather
//! than inferring everything from the schema.
//!
//! Scoped by `connection_id` — the *saved* connection's stable id — for the
//! same reason `chats.rs` and `cubbies.rs` are: a `session_id` is regenerated
//! on every reconnect, so it cannot identify "the same database" across a
//! restart, and which repository backs a database is exactly the kind of fact
//! that should survive one. Ad-hoc connections have no stable id and so
//! simply never get an entry here, matching how they already work for chats.
//!
//! Deliberately connection-scoped rather than per-chat: which tables matter
//! varies per question (hence per-chat attached tables), but which repository
//! backs a database is a property of the project and does not change between
//! questions.
//!
//! Only a path is stored — never a copy of any file. The repository is read
//! live at question time, so it is never stale, and deleting the attachment
//! leaves the code untouched.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "repos.json";

/// One attached repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedRepo {
    /// Stable id; assigned on first save if empty.
    #[serde(default)]
    pub id: String,
    /// A *saved* connection's stable id — see the module comment.
    pub connection_id: String,
    /// Absolute path to the repository root, as chosen in the folder picker.
    pub path: String,
    /// Display name. Defaults to the directory's own name, and is what the
    /// model sees as the repository's identity in tool arguments, so it has
    /// to be unique within a connection — `unique_name` enforces that.
    pub name: String,
    #[serde(default)]
    pub added_at: u64,
}

/// Reads and writes the attached-repository file.
pub struct RepoStore {
    path: PathBuf,
}

impl RepoStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    /// Every attached repository across all connections, oldest first.
    /// Filtering to one connection is the caller's job, matching how
    /// `CubbyStore::list` divides that labor with the frontend.
    pub fn list(&self) -> Result<Vec<AttachedRepo>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        let mut list: Vec<AttachedRepo> =
            serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))?;
        list.sort_by(|a, b| a.added_at.cmp(&b.added_at));
        Ok(list)
    }

    /// Just the repositories attached to one connection — what a chat turn
    /// needs, and the only view the AI tools are ever given.
    pub fn for_connection(&self, connection_id: &str) -> Result<Vec<AttachedRepo>, DbError> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|repo| repo.connection_id == connection_id)
            .collect())
    }

    /// Attach a repository, or rename one already attached.
    ///
    /// Rejects a path that is not an existing directory: the failure is worth
    /// catching while the user is still looking at the folder picker, rather
    /// than surfacing later as an unexplained empty search inside a chat.
    pub fn upsert(&self, mut repo: AttachedRepo) -> Result<AttachedRepo, DbError> {
        let path = Path::new(&repo.path);
        if !path.is_dir() {
            return Err(DbError::new(
                DbErrorKind::Internal,
                format!("{} is not a folder that exists.", repo.path),
            ));
        }
        // Canonicalize once, on the way in, so every later path check
        // compares against a real root with symlinks already resolved.
        if let Ok(resolved) = path.canonicalize() {
            repo.path = resolved.to_string_lossy().to_string();
        }

        let mut list = self.list()?;
        if repo.id.is_empty() {
            // Re-attaching the same folder updates the existing entry rather
            // than listing it twice.
            match list
                .iter()
                .find(|r| r.connection_id == repo.connection_id && r.path == repo.path)
            {
                Some(existing) => {
                    repo.id = existing.id.clone();
                    repo.added_at = existing.added_at;
                }
                None => {
                    repo.id = new_id();
                    repo.added_at = now_millis();
                }
            }
        } else if let Some(existing) = list.iter().find(|r| r.id == repo.id) {
            repo.added_at = existing.added_at;
        }

        if repo.name.trim().is_empty() {
            repo.name = default_name(&repo.path);
        }
        repo.name = unique_name(&repo.name, &list, &repo.connection_id, &repo.id);

        if let Some(existing) = list.iter_mut().find(|r| r.id == repo.id) {
            *existing = repo.clone();
        } else {
            list.push(repo.clone());
        }
        self.write(&list)?;
        Ok(repo)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.list()?;
        list.retain(|r| r.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[AttachedRepo]) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json = serde_json::to_vec_pretty(list).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }
}

/// The folder's own name, which is what someone would call the repository.
fn default_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".to_string())
}

/// Names are how the model addresses a repository in a tool call, so two
/// folders both called `api` within one connection would be ambiguous. The
/// second becomes `api (2)`.
fn unique_name(
    desired: &str,
    list: &[AttachedRepo],
    connection_id: &str,
    own_id: &str,
) -> String {
    let taken = |candidate: &str| {
        list.iter().any(|r| {
            r.connection_id == connection_id && r.id != own_id && r.name == candidate
        })
    };
    let base = desired.trim();
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base} ({n})"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| base.to_string())
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
    format!("repo_{nanos}")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
