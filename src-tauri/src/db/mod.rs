//! Database driver abstraction.
//!
//! Everything engine-specific lives behind the [`DatabaseDriver`] and
//! [`DbSession`] traits. The rest of the application — the Tauri commands, the
//! saved-connection store, the frontend — speaks only in the neutral types
//! declared here (`ConnectionParams`, `SchemaNode`, `QueryResult`, ...).
//!
//! Adding a second engine later means writing a new module that implements
//! these two traits and registering it in [`driver_for`]; no UI code changes.

mod error;
pub mod postgres;

pub use error::{DbError, DbErrorKind};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Identifies a database engine. Only Postgres exists in v1, but the tag is
/// carried through connection records so a future engine can be dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
}

impl Default for Engine {
    fn default() -> Self {
        Engine::Postgres
    }
}

/// Connection details. Either a full `connection_string` is provided, or the
/// individual fields are; the driver decides how to assemble them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParams {
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Result of a successful connect/test: what server we reached and how long it
/// took, mirroring the "Connected · 42 ms · Postgres 16.2" chip in the design.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub engine: Engine,
    pub server_version: String,
    pub elapsed_ms: u64,
}

/// A schema and the tables/views it contains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub name: String,
    pub kind: TableKind,
    /// Planner's estimated live row count (fast; never scans the table).
    pub estimated_rows: Option<i64>,
    pub columns: Vec<ColumnNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnNode {
    pub name: String,
    /// Human-readable type, e.g. `int8`, `numeric`, `timestamptz`.
    pub data_type: String,
    pub nullable: bool,
    /// True when this column participates in the table's primary key. Used later
    /// to decide whether result cells are editable.
    pub is_primary_key: bool,
    /// Foreign keys this column participates in (usually zero or one). Drives the
    /// "jump to referenced row" affordance in the results grid.
    #[serde(default)]
    pub references: Vec<ForeignKeyRef>,
    /// Columns in other tables whose foreign key points AT this column (the
    /// reverse direction). Drives "show rows that reference this". Note the
    /// referenced column need not be named `id` — any unique column can be a FK
    /// target.
    #[serde(default)]
    pub referenced_by: Vec<ForeignKeyRef>,
}

/// A column this column points at via a foreign key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

/// A column in a result set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
}

/// The outcome of running a statement from the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    /// Row-major cell values, already rendered to text. `None` is SQL NULL.
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub elapsed_ms: u64,
    /// For non-row-returning statements, the command tag, e.g. `UPDATE 3`.
    pub command_tag: Option<String>,
    /// True when the driver appended a default LIMIT to an unbounded SELECT.
    pub limit_applied: bool,
}

/// A driver knows how to test connectivity and open a live session for one
/// engine. Implementations are stateless; per-connection state lives in the
/// [`DbSession`] they return.
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// Connect, read the server version, and drop the connection. Used by the
    /// "Test connection" action before saving.
    async fn test_connection(&self, params: &ConnectionParams) -> Result<ConnectionInfo, DbError>;

    /// Open a live session. In v1 only one session is held open at a time.
    async fn connect(
        &self,
        params: &ConnectionParams,
    ) -> Result<Box<dyn DbSession>, DbError>;
}

/// A live, connected session.
#[async_trait]
pub trait DbSession: Send + Sync {
    fn info(&self) -> &ConnectionInfo;

    /// Read the schema tree (schemas -> tables/views -> columns) using the
    /// engine's catalog / information_schema.
    async fn fetch_schema(&self) -> Result<Vec<SchemaNode>, DbError>;

    /// Run a single statement from the SQL editor. The driver is responsible for
    /// applying the default row cap to unbounded SELECTs — the frontend never
    /// rewrites SQL.
    async fn run_query(&self, sql: &str) -> Result<QueryResult, DbError>;

    /// Build the `SELECT * FROM table [WHERE filter] LIMIT n` used by the table
    /// browser. `filter` is a user-authored predicate (the WHERE bar), inserted
    /// verbatim. Centralizing this keeps all generated SQL in the backend.
    fn select_top_sql(
        &self,
        schema: &str,
        table: &str,
        filter: Option<&str>,
        limit: u32,
    ) -> String;
}

/// The default row cap applied to unbounded SELECT statements.
pub const DEFAULT_ROW_LIMIT: u32 = 100;

/// Resolve the driver for an engine. The single place engines are dispatched.
pub fn driver_for(engine: Engine) -> Box<dyn DatabaseDriver> {
    match engine {
        Engine::Postgres => Box::new(postgres::PostgresDriver::new()),
    }
}
