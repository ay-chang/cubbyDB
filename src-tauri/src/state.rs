//! Shared application state managed by Tauri.
//!
//! Holds the single active session (v1 keeps one connection open at a time) and
//! the resolved data directory used by the connection and history stores.

use std::path::PathBuf;

use tokio::sync::Mutex;

use crate::connections::{ConnectionStore, LastConnectionStore};
use crate::db::{ConnectionParams, DbSession, Engine};
use crate::history::HistoryStore;

/// The currently open connection, if any.
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
}

pub struct AppState {
    data_dir: PathBuf,
    pub active: Mutex<Option<ActiveSession>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            active: Mutex::new(None),
        }
    }

    pub fn connection_store(&self) -> ConnectionStore {
        ConnectionStore::new(&self.data_dir)
    }

    pub fn history_store(&self) -> HistoryStore {
        HistoryStore::new(&self.data_dir)
    }

    pub fn last_connection_store(&self) -> LastConnectionStore {
        LastConnectionStore::new(&self.data_dir)
    }
}
