//! Error type shared across the database layer.
//!
//! Errors are serialized to the frontend so the UI can show the *raw* database
//! message inline (per the design spec: errors are never modal). For Postgres
//! we preserve the SQLSTATE code and any position information the server sends.

use serde::Serialize;

/// A database error, in a shape the frontend can render as an inline strip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    /// Human-first message, e.g. `column "naem" does not exist`.
    pub message: String,
    /// SQLSTATE code when the engine provides one, e.g. `42703`.
    pub code: Option<String>,
    /// Optional server-provided hint, e.g. `did you mean "name"?`.
    pub hint: Option<String>,
    /// 1-based character position within the query, when available.
    pub position: Option<u32>,
    /// A short, stable category so the UI can branch without parsing `message`.
    pub kind: DbErrorKind,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DbErrorKind {
    /// Could not establish or authenticate a connection.
    Connection,
    /// The server rejected the SQL (syntax, missing column, constraint, ...).
    Query,
    /// No active connection for an operation that requires one.
    NotConnected,
    /// Anything else (I/O, TLS setup, internal invariants).
    Internal,
}

impl DbError {
    pub fn new(kind: DbErrorKind, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            hint: None,
            position: None,
            kind,
        }
    }

    pub fn not_connected() -> Self {
        Self::new(
            DbErrorKind::NotConnected,
            "No active connection. Connect to a database first.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(DbErrorKind::Internal, message)
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for DbError {}
