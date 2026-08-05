//! The agent's tool surface: schemas the model sees, and the dispatch that
//! runs them.
//!
//! Everything that touches the database goes through `DbSession`, and every
//! statement any tool here executes goes through `run_read_only_query` — the
//! `BEGIN READ ONLY … ROLLBACK` wrapper in `db/postgres.rs`.
//!
//! Session *lifecycle* deliberately stays out of here: `commands::ai_chat`
//! owns the lock and the reconnect-on-drop retry, and hands this module a
//! borrowed session that is already known-good.

pub mod schema;
pub mod sql;

use serde_json::{json, Value};

use super::ToolTrace;
use crate::db::{DbError, DbErrorKind, DbSession, SchemaNode};

/// What a tool needs to do its job. `schema` is the tree the frontend
/// already fetched and passed in with the turn — no tool re-reads the
/// catalog for it.
pub struct ToolContext<'a> {
    pub session: &'a dyn DbSession,
    pub schema: &'a [SchemaNode],
}

/// One tool's result: what the model reads, and what the user sees in the
/// panel's trace disclosure.
pub struct ToolOutcome {
    pub content: String,
    pub trace: ToolTrace,
}

/// Neutral tool definitions. Anthropic consumes `input_schema` directly;
/// OpenAI maps it to the Responses API's `parameters` field.
///
/// Descriptions state *when* to reach for a tool, not just what it does —
/// that phrasing measurably improves tool selection, and it's the same
/// guidance the system prompt repeats.
///
/// This value must be byte-identical across the turns of a conversation so
/// provider-side prompt caching can reuse the stable prefix.
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "run_sql",
            "description": "Execute a single read-only SQL SELECT against the connected PostgreSQL database and return its rows. Use this whenever the answer depends on actual data rather than structure. The statement runs inside a READ ONLY transaction that is always rolled back, so INSERT/UPDATE/DELETE/DDL will be rejected.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single SELECT statement." }
                },
                "required": ["sql"],
            }
        },
        {
            "name": "describe_table",
            "description": "Full detail for one table: every column with type, nullability and default, plus indexes, check constraints, and foreign keys in both directions. Call this before writing SQL against a table whose columns you have not already seen, rather than guessing at column names.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "schema": { "type": "string", "description": "Schema name, e.g. public." },
                    "table": { "type": "string", "description": "Table name." }
                },
                "required": ["schema", "table"],
            }
        },
        {
            "name": "sample_rows",
            "description": "Return a few real rows from a table. Use this when the shape or encoding of the data matters and the column types alone do not tell you: what values a status column actually holds, how dates are formatted, whether a nullable field is null in practice.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "schema": { "type": "string" },
                    "table": { "type": "string" },
                    "limit": { "type": "integer", "description": "How many rows, 1-20. Defaults to 5." }
                },
                "required": ["schema", "table"],
            }
        },
        {
            "name": "search_schema",
            "description": "Find tables and columns whose names contain a substring. Use this when you do not know where something lives — especially on a large database, where the schema listing in the system prompt is abbreviated.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Substring to match, case-insensitive." }
                },
                "required": ["query"],
            }
        },
        {
            "name": "explain_query",
            "description": "Return the PostgreSQL query plan for a statement. Use this for questions about performance, index usage, or why a query is slow. Set analyze to true to execute the statement and report real timings instead of estimates.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "The statement to explain." },
                    "analyze": {
                        "type": "boolean",
                        "description": "Actually run the statement to collect real row counts and timings. Defaults to false."
                    }
                },
                "required": ["sql"],
            }
        },
    ])
}

/// Runs one tool call. An unknown tool name is an error returned *to the
/// model* by the caller rather than a panic — models occasionally invent
/// names, and the loop recovers fine when told so.
pub async fn execute(
    ctx: &ToolContext<'_>,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, DbError> {
    match name {
        "run_sql" => sql::run_sql(ctx, input).await,
        "explain_query" => sql::explain_query(ctx, input).await,
        "describe_table" => schema::describe_table(ctx, input).await,
        "sample_rows" => schema::sample_rows(ctx, input).await,
        "search_schema" => schema::search_schema(ctx, input),
        other => Err(DbError::new(
            DbErrorKind::Internal,
            format!("Unknown tool: {other}"),
        )),
    }
}

/// Pulls a required string argument out of a tool's input object.
pub(crate) fn arg_str(input: &Value, key: &str) -> Result<String, DbError> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            DbError::new(
                DbErrorKind::Internal,
                format!("Tool call is missing required argument `{key}`."),
            )
        })
}
