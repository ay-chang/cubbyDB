//! Persistence for saved AI chats — unlike `saved_queries.rs` (deliberately
//! *global*, reusable across databases with the same shape), a chat only
//! makes sense against the specific database it was asked about, so these
//! are scoped by `connection_id` — the *saved* connection's stable id
//! (`ConnectionSlot.current.connectionId` on the frontend), not a `session_id`
//! (regenerated every reconnect, so it can't identify "the same database"
//! across a restart). Ad-hoc connections have no stable id and so simply
//! never get an entry here — their chats stay in-memory only, same as this
//! whole feature didn't exist for them.
//!
//! Otherwise this mirrors `saved_queries.rs`'s `SavedQueryStore` almost
//! exactly: one JSON file holding the full list, `id`/`upsert`/`delete`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ai::ChatMessage;
use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "ai_chats.json";

/// The title shown for a brand-new chat if the first user message is empty
/// (shouldn't normally happen, but avoids ever storing a blank title).
const FALLBACK_TITLE: &str = "New chat";

/// How many characters of the first user message a derived title keeps.
const TITLE_MAX_CHARS: usize = 50;

/// A saved chat's full record, including every message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatThread {
    /// Stable id; assigned on first save if empty.
    #[serde(default)]
    pub id: String,
    pub connection_id: String,
    /// Callers should send `""` on every routine turn — see
    /// `AiChatStore::upsert` for why that's safe (an existing title is never
    /// blanked out by an empty incoming one).
    #[serde(default)]
    pub title: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// The list view's lightweight shape — no message bodies, so listing a
/// connection's chats doesn't ship every message of every one of them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSummary {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
}

impl From<&AiChatThread> for AiChatSummary {
    fn from(thread: &AiChatThread) -> Self {
        Self {
            id: thread.id.clone(),
            title: thread.title.clone(),
            updated_at: thread.updated_at,
        }
    }
}

/// Reads and writes the saved-chats file.
pub struct AiChatStore {
    path: PathBuf,
}

impl AiChatStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    fn read_all(&self) -> Result<Vec<AiChatThread>, DbError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        serde_json::from_slice(&bytes).map_err(|e| DbError::internal(e.to_string()))
    }

    /// A connection's chats, newest-used first — so `[0]` is what "resume
    /// where I left off" (the AI panel's auto-open-on-launch) opens.
    pub fn list_for_connection(&self, connection_id: &str) -> Result<Vec<AiChatSummary>, DbError> {
        let mut list = self.read_all()?;
        list.retain(|c| c.connection_id == connection_id);
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list.iter().map(AiChatSummary::from).collect())
    }

    /// The full record, including every message — fetched only when a chat
    /// is actually opened, not for the list view.
    pub fn get(&self, id: &str) -> Result<Option<AiChatThread>, DbError> {
        Ok(self.read_all()?.into_iter().find(|c| c.id == id))
    }

    /// Insert or update a chat by id. On create, a blank `title` is derived
    /// from the first user message; on update, a blank `title` leaves the
    /// existing one untouched (rather than blanking it) — this is what lets
    /// the frontend always pass `""` for routine turns and only actually
    /// rename via `rename`, without needing to track/resend the title itself.
    pub fn upsert(&self, mut thread: AiChatThread) -> Result<AiChatThread, DbError> {
        let mut list = self.read_all()?;
        let now = now_millis();

        if thread.id.is_empty() {
            thread.id = new_id();
            thread.created_at = now;
            if thread.title.trim().is_empty() {
                thread.title = derive_title(&thread.messages);
            }
        } else if let Some(existing) = list.iter().find(|c| c.id == thread.id) {
            thread.created_at = existing.created_at;
            if thread.title.trim().is_empty() {
                thread.title = existing.title.clone();
            }
        }
        thread.updated_at = now;

        if let Some(existing) = list.iter_mut().find(|c| c.id == thread.id) {
            *existing = thread.clone();
        } else {
            list.push(thread.clone());
        }
        self.write(&list)?;
        Ok(thread)
    }

    /// Renames a chat without touching `updated_at` — renaming isn't "using"
    /// the chat, so it shouldn't reorder the (most-recently-used) list.
    pub fn rename(&self, id: &str, title: String) -> Result<AiChatSummary, DbError> {
        let mut list = self.read_all()?;
        let Some(thread) = list.iter_mut().find(|c| c.id == id) else {
            return Err(DbError::new(DbErrorKind::Internal, "Chat not found."));
        };
        thread.title = title;
        let summary = AiChatSummary::from(&*thread);
        self.write(&list)?;
        Ok(summary)
    }

    pub fn delete(&self, id: &str) -> Result<(), DbError> {
        let mut list = self.read_all()?;
        list.retain(|c| c.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[AiChatThread]) -> Result<(), DbError> {
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

/// The first user message, trimmed and truncated — good enough for a title
/// without paying for a separate model call just to name a chat.
fn derive_title(messages: &[ChatMessage]) -> String {
    let first_user = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.trim())
        .unwrap_or("");

    if first_user.is_empty() {
        return FALLBACK_TITLE.to_string();
    }
    if first_user.chars().count() <= TITLE_MAX_CHARS {
        return first_user.to_string();
    }
    let truncated: String = first_user.chars().take(TITLE_MAX_CHARS).collect();
    format!("{truncated}…")
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
    format!("chat_{nanos}")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
