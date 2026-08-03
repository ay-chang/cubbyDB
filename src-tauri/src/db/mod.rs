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

/// A schema and everything in it: tables/views, functions/procedures,
/// sequences, and enum types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
    pub functions: Vec<FunctionNode>,
    pub sequences: Vec<SequenceNode>,
    pub types: Vec<TypeNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub name: String,
    pub kind: TableKind,
    /// Planner's estimated live row count (fast; never scans the table).
    pub estimated_rows: Option<i64>,
    pub columns: Vec<ColumnNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

/// A function or procedure, listed lightly (name + signature) in the schema
/// tree — its body is fetched separately, only when opened (see
/// [`FunctionDefinition`]), since bodies can be large and aren't needed just
/// to browse the list. Aggregate and window functions (`pg_proc.prokind`
/// `'a'`/`'w'`) are deliberately excluded — rarer to browse and would need
/// different definition rendering than a plain function/procedure body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionNode {
    /// The function's `pg_proc.oid`, cast to `i64`. Needed to disambiguate
    /// overloads (same name, different argument types) when fetching the
    /// definition — Postgres allows multiple functions with the same name.
    pub oid: i64,
    pub name: String,
    /// Display-ready argument list from `pg_get_function_arguments`, e.g.
    /// `"user_id integer, since timestamptz DEFAULT now()"`.
    pub arguments: String,
    /// `None` for procedures, which have no return type.
    pub return_type: Option<String>,
    pub kind: FunctionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FunctionKind {
    Function,
    Procedure,
}

/// The table/column a sequence is `OWNED BY` (e.g. the sequence backing a
/// `SERIAL`/`GENERATED ... AS IDENTITY` column), if any — always in the same
/// schema as the sequence itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceOwner {
    pub table: String,
    pub column: String,
}

/// A sequence, listed lightly in the schema tree — its current value and
/// bounds are fetched separately, only when opened (see [`SequenceDetails`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceNode {
    pub name: String,
    pub owned_by: Option<SequenceOwner>,
}

/// A custom enum type. Values are cheap and small, so — unlike functions and
/// sequences — they're included directly here rather than fetched lazily;
/// the schema tree shows them by expanding the type row, the same
/// interaction as expanding a table to see its columns.
///
/// Deliberately enum types only, not composite or domain types — same
/// honest-scope-cut as [`TableStructure`] not reconstructing `CREATE TABLE`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeNode {
    pub name: String,
    /// In their defined display order (`pg_enum.enumsortorder`).
    pub values: Vec<String>,
}

/// A function/procedure's full body — `pg_get_functiondef(oid)`, fetched only
/// when the function's tab is opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDefinition {
    pub definition: String,
}

/// A sequence's current value and configuration, straight from Postgres's own
/// `pg_sequences` system view — fetched only when the sequence's tab is
/// opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDetails {
    pub data_type: String,
    pub start_value: i64,
    pub min_value: i64,
    pub max_value: i64,
    pub increment_by: i64,
    pub cycle: bool,
    pub cache_size: i64,
    /// `None` until `nextval()` has ever been called on this sequence.
    pub last_value: Option<i64>,
}

/// Column, index, and check-constraint details for one table — the "View
/// structure" panel. Foreign keys aren't repeated here: the frontend already
/// has them per-column from `fetch_schema` and merges them in.
///
/// Deliberately does NOT attempt to reconstruct a full `CREATE TABLE`
/// statement — storage params, partitioning, generated/identity columns, and
/// so on make a faithful reconstruction genuinely complex and easy to get
/// subtly wrong. Index and constraint text instead comes straight from
/// Postgres's own `pg_get_*def()` functions rather than being hand-built, so
/// what's shown is always accurate for what it does cover.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<StructureColumn>,
    pub indexes: Vec<IndexDetail>,
    pub check_constraints: Vec<CheckConstraintDetail>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    /// The column's default expression (e.g. `nextval(...)`, `now()`, a
    /// literal), verbatim from Postgres. `None` means no default.
    pub default_expr: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    /// The index's own `CREATE INDEX ...` statement (`pg_indexes.indexdef`).
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckConstraintDetail {
    pub name: String,
    /// The constraint's own `CHECK (...)` text (`pg_get_constraintdef`).
    pub definition: String,
}

/// A single column/value pair used to describe a row edit: which column, and
/// either its current value (identifying the row, in a `WHERE`) or its new
/// value (setting it, in a `SET`). `value` is `None` for SQL NULL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    pub column: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// A column in a result set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
}

/// Rows in one other table that reference the row(s) about to be deleted,
/// via one foreign key constraint — the "delete impact" preview shown before
/// a delete that would otherwise just fail with a raw FK-violation error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependentRowsPreview {
    pub schema: String,
    pub table: String,
    pub fk_constraint: String,
    /// This dependent table's own columns, in the order `sample_rows` uses —
    /// its primary key first, then a few more for context.
    pub columns: Vec<String>,
    pub sample_rows: Vec<Vec<Option<String>>>,
    /// The real count — may be larger than `sample_rows.len()`.
    pub total_count: i64,
    /// True when `total_count` exceeds the sample shown.
    pub truncated: bool,
    /// Rows that reference *these* dependent rows, one level deeper (e.g.
    /// `order_items` depending on `orders` depending on the deleted
    /// `customer`). Empty if nothing references this table, or the walk was
    /// cut off — see [`DeleteImpact::incomplete`].
    pub children: Vec<DependentRowsPreview>,
}

/// Everything that would need to be deleted alongside the row(s) the user
/// asked to delete, discovered by walking the foreign-key graph.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImpact {
    pub dependents: Vec<DependentRowsPreview>,
    /// True if the walk hit its depth or row-count safety cap before fully
    /// resolving — the real impact may be larger than what's shown. Never
    /// silently truncated without this being set.
    pub incomplete: bool,
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

    /// Run a single statement read-only — used by the AI assistant to answer
    /// data questions with model-generated SQL, which must never be trusted
    /// to only ever contain a `SELECT`. Enforced by the driver at the
    /// transaction level (e.g. Postgres's `BEGIN READ ONLY`, always rolled
    /// back), not by inspecting the SQL text, which can't reliably tell a
    /// read from a write (CTEs, `; DROP ...`, etc. all defeat a text check).
    async fn run_read_only_query(&self, sql: &str) -> Result<QueryResult, DbError>;

    /// Build the `SELECT * FROM table [WHERE filter] LIMIT n [OFFSET m]` used by
    /// the table browser. `filter` is a user-authored predicate (the WHERE bar),
    /// inserted verbatim. `offset` paginates (0 for the first page).
    /// Centralizing this keeps all generated SQL in the backend.
    fn select_top_sql(
        &self,
        schema: &str,
        table: &str,
        filter: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> String;

    /// Apply an edit to exactly one row via a primary-key-scoped `UPDATE`.
    /// `primary_key` identifies the row (its *current* values, used in the
    /// `WHERE`); `changes` are the columns being set. Values are bound as
    /// query parameters, never interpolated into the SQL text.
    ///
    /// Errors if the primary key no longer matches exactly one row (e.g. it
    /// was changed or deleted elsewhere since the grid was loaded) — an edit
    /// is never allowed to silently touch zero or more than one row.
    async fn update_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[ColumnValue],
        changes: &[ColumnValue],
    ) -> Result<(), DbError>;

    /// Insert one new row. `values` are the columns the user filled in; any
    /// column not listed is left to its database default (so an empty draft row
    /// becomes `INSERT ... DEFAULT VALUES`). A `None` value inserts SQL NULL.
    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[ColumnValue],
    ) -> Result<(), DbError>;

    /// Delete exactly one row via a primary-key-scoped `DELETE`. Errors if the
    /// key no longer matches exactly one row, mirroring [`update_row`].
    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[ColumnValue],
    ) -> Result<(), DbError>;

    /// Read-only preview of what deleting `primary_keys` would cascade into
    /// — every row in every other table that references one of them,
    /// walked transitively. `primary_keys` is a list (not one row) so a
    /// multi-row delete can be checked in a single call.
    async fn delete_impact(
        &self,
        schema: &str,
        table: &str,
        primary_keys: &[Vec<ColumnValue>],
    ) -> Result<DeleteImpact, DbError>;

    /// Delete `primary_keys` and everything [`delete_impact`] would report
    /// for them, in one transaction — dependents deepest-first, the
    /// requested rows last, so nothing is ever left half-cascaded. Returns
    /// the total number of rows deleted (dependents + the requested rows).
    ///
    /// [`delete_impact`]: DbSession::delete_impact
    async fn delete_row_cascade(
        &self,
        schema: &str,
        table: &str,
        primary_keys: &[Vec<ColumnValue>],
    ) -> Result<u64, DbError>;

    /// Column, index, and check-constraint details for one table — the "View
    /// structure" panel.
    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError>;

    /// A function/procedure's full body, identified by its `pg_proc.oid`
    /// (disambiguates overloads — see [`FunctionNode::oid`]).
    async fn function_definition(&self, oid: i64) -> Result<FunctionDefinition, DbError>;

    /// A sequence's current value and configuration.
    async fn sequence_details(&self, schema: &str, name: &str) -> Result<SequenceDetails, DbError>;

    /// A lightweight, independent handle that can cancel whatever this
    /// session is *currently* running. Must be usable concurrently with an
    /// in-flight call to `run_query` on this same session — it cannot require
    /// exclusive access to the session, since the caller of an in-flight
    /// query already holds that exclusivity for the query's whole duration
    /// (see `AppState.canceller` in `state.rs`, which is a separate lock from
    /// `AppState.active` for exactly this reason).
    fn canceller(&self) -> Box<dyn QueryCanceller>;
}

/// See [`DbSession::canceller`].
#[async_trait]
pub trait QueryCanceller: Send + Sync {
    /// Best-effort: ask the server to interrupt whatever is currently running
    /// on the session this canceller came from. If nothing is running, this
    /// is a harmless no-op (Postgres just won't find a matching query to
    /// cancel).
    async fn cancel(&self) -> Result<(), DbError>;
}

/// The default row cap applied to unbounded SELECT statements.
pub const DEFAULT_ROW_LIMIT: u32 = 100;

/// Resolve the driver for an engine. The single place engines are dispatched.
pub fn driver_for(engine: Engine) -> Box<dyn DatabaseDriver> {
    match engine {
        Engine::Postgres => Box::new(postgres::PostgresDriver::new()),
    }
}
