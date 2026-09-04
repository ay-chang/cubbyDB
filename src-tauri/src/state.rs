//! Shared application state managed by Tauri.
//!
//! Holds every live session, keyed by an opaque session id (multiple
//! connections can be open concurrently — the frontend picks which one's
//! workspace is visible), and the resolved data directory used by the
//! connection and history stores.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use tokio::sync::Mutex;

use crate::ai::chats::AiChatStore;
use crate::ai::config::AiConfigStore;
use crate::connections::{ConnectionStore, LastConnectionStore};
use crate::cubbies::CubbyStore;
use crate::db::{ConnectionParams, DbSession, Engine, QueryCanceller};
use crate::history::HistoryStore;
use crate::saved_queries::SavedQueryStore;
use crate::ssh_known_hosts::SshKnownHostsStore;

/// One open connection.
pub struct ActiveSession {
    pub session: Box<dyn DbSession>,
    /// Display name (from the saved connection or a derived label).
    pub name: String,
    /// Saved-connection id, when the session came from a saved record.
    pub connection_id: Option<String>,
    /// The params used to open this session, kept so a dropped connection can be
    /// transparently re-established (serverless databases close idle links).
    pub params: ConnectionParams,
    pub engine: Engine,
    /// Last user-triggered database operation for this session. After a quiet
    /// period, the next operation checks the connection before using it so a
    /// serverless endpoint's stale socket cannot absorb the user's request.
    pub last_request_at: Instant,
}

pub struct AppState {
    data_dir: PathBuf,
    /// Every live session, keyed by session id (assigned in `connect`).
    pub active: Mutex<HashMap<String, ActiveSession>>,
    /// Per-session handles that can cancel whatever that session is
    /// currently running. Deliberately a *separate* lock from `active`:
    /// `active`'s lock is held for the whole duration of an in-flight
    /// `run_query`, so a cancel command that needed the same lock would just
    /// queue up behind the very query it's trying to interrupt. A session's
    /// entry is refreshed on every connect/reconnect and removed on
    /// disconnect.
    pub canceller: Mutex<HashMap<String, Box<dyn QueryCanceller>>>,
    /// One end of a `watch` channel per in-flight `ai_chat` turn, keyed by
    /// session id — the same shape as `canceller` above, and for the same
    /// reason: a separate lock so `ai_cancel_chat` isn't stuck queuing
    /// behind the very turn it's trying to stop. `ai_chat` inserts an entry
    /// for the duration of its call and removes it when done; `ai_cancel_chat`
    /// sends `true` on it if still present. Cancelling races the whole
    /// provider call with the channel via `tokio::select!`, so it works
    /// uniformly across all four AI backends without any of them knowing
    /// cancellation exists — the losing future is simply dropped, which is
    /// what actually aborts an in-flight HTTP request or (with
    /// `kill_on_drop`, see `claude_code.rs`) kills a bridged CLI process.
    pub ai_cancellers: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            active: Mutex::new(HashMap::new()),
            canceller: Mutex::new(HashMap::new()),
            ai_cancellers: Mutex::new(HashMap::new()),
        }
    }

    pub fn connection_store(&self) -> ConnectionStore {
        ConnectionStore::new(&self.data_dir)
    }

    pub fn history_store(&self) -> HistoryStore {
        HistoryStore::new(&self.data_dir)
    }

    pub fn ssh_known_hosts_store(&self) -> SshKnownHostsStore {
        SshKnownHostsStore::new(&self.data_dir)
    }

    pub fn last_connection_store(&self) -> LastConnectionStore {
        LastConnectionStore::new(&self.data_dir)
    }

    pub fn saved_query_store(&self) -> SavedQueryStore {
        SavedQueryStore::new(&self.data_dir)
    }

    pub fn cubby_store(&self) -> CubbyStore {
        CubbyStore::new(&self.data_dir)
    }

    pub fn ai_config_store(&self) -> AiConfigStore {
        AiConfigStore::new(&self.data_dir)
    }

    pub fn ai_chat_store(&self) -> AiChatStore {
        AiChatStore::new(&self.data_dir)
    }

    pub fn ai_audit_store(&self) -> crate::ai::audit::AiAuditStore {
        crate::ai::audit::AiAuditStore::new(&self.data_dir)
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }
}
