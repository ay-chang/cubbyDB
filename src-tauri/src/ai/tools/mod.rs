//! The agent's tool surface: schemas the model sees, and the dispatch that
//! runs them.
//!
//! Everything that touches the database goes through `ReadOnlyDb`, a narrow
//! capability wrapper that does not expose any mutation method. Every SQL
//! statement then passes the driver's command allowlist and the PostgreSQL
//! `BEGIN READ ONLY … ROLLBACK` boundary.
//!
//! Session *lifecycle* deliberately stays out of here: `commands::ai_chat`
//! owns the lock and the reconnect-on-drop retry, and hands this module a
//! borrowed session that is already known-good.

pub mod repo;
pub mod schema;
pub mod sql;

use serde_json::{json, Value};

use super::ToolTrace;
use crate::ai::read_only::ReadOnlyDb;
use crate::ai::read_only_repo::ReadOnlyRepo;
use crate::db::{DbError, DbErrorKind, DbSession, SchemaNode};
use crate::repos::AttachedRepo;

/// What a tool needs to do its job. `schema` is the tree the frontend
/// already fetched and passed in with the turn — no tool re-reads the
/// catalog for it.
pub struct ToolContext<'a> {
    db: ReadOnlyDb<'a>,
    schema: &'a [SchemaNode],
    /// Repositories attached to this connection. Owned rather than borrowed
    /// so the filesystem tools can hand a clone to the blocking pool; empty
    /// when nothing is attached, which is also what leaves the repo tools out
    /// of `tool_definitions`.
    repos: ReadOnlyRepo,
}

impl<'a> ToolContext<'a> {
    pub fn new(
        session: &'a dyn DbSession,
        schema: &'a [SchemaNode],
        repos: Vec<AttachedRepo>,
    ) -> Self {
        Self {
            db: ReadOnlyDb::new(session),
            schema,
            repos: ReadOnlyRepo::new(repos),
        }
    }
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
/// provider-side prompt caching can reuse the stable prefix. `include_repo`
/// is stable for that purpose: it reflects whether repositories are attached
/// to the connection, which does not change mid-conversation in normal use.
///
/// `include_repo` is false for the Claude Code and Codex routes even when
/// repositories *are* attached — those get their own native file tools
/// pointed at the same directories instead, which read code better than
/// anything reimplemented here. It is true for the Anthropic and OpenAI
/// API-key routes, which have no file tools of their own.
pub fn tool_definitions(include_repo: bool) -> Value {
    let mut tools = json!([
        {
            "name": "run_sql",
            "description": "Execute exactly one read-only SELECT-family statement against the connected PostgreSQL database and return its rows. Use this whenever the answer depends on actual data rather than structure. A hardcoded command allowlist rejects writes, DDL, session commands, and multiple statements before execution; PostgreSQL then runs the statement in a READ ONLY transaction that is always rolled back. Never send a change through this tool, not even to test it: when the user wants to modify data or schema, write the statement in a fenced sql block in your reply instead, for them to run themselves.",
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
            "description": "Return the PostgreSQL query plan for one read-only SELECT-family statement. Use this for questions about performance, index usage, or why a query is slow. Set analyze to true to execute only that read-only statement and report real timings instead of estimates. Write, DDL, session, and multi-statement input is rejected before execution.",
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
    ]);

    if include_repo {
        let repo_tools = json!([
            {
                "name": "search_repo",
                "description": "Search the attached code repositories for a regular expression and return matching lines with their file and line number. This is the way to find out how the application actually uses the database — where a table is written to, which code path sets a column, what a status value means in practice. Search for a table or column name when the schema alone does not answer the question. Case-insensitive; skips anything .gitignore excludes.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regular expression to search for, e.g. a table or column name." },
                        "repo": { "type": "string", "description": "Which attached repository to search. Omit to search all of them." },
                        "max_results": { "type": "integer", "description": "Maximum matching lines to return. Defaults to 50." }
                    },
                    "required": ["pattern"],
                }
            },
            {
                "name": "read_file",
                "description": "Read a file from an attached repository, optionally a line range of it, returned with line numbers. Use it after search_repo to see the code around a match: the query being built, the model definition, the migration that created a column.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the repository root, exactly as search_repo reported it." },
                        "repo": { "type": "string", "description": "Which attached repository. Omit when only one is attached." },
                        "start_line": { "type": "integer", "description": "First line to return. Defaults to 1." },
                        "end_line": { "type": "integer", "description": "Last line to return." }
                    },
                    "required": ["path"],
                }
            },
            {
                "name": "list_repo_files",
                "description": "List the files in an attached repository, or in one subdirectory of it. Use it to orient yourself before searching — to find where migrations, models, or queries live.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "repo": { "type": "string", "description": "Which attached repository. Omit when only one is attached." },
                        "subdirectory": { "type": "string", "description": "Path relative to the repository root. Omit to list everything." }
                    },
                    "required": [],
                }
            },
        ]);
        if let (Some(list), Some(extra)) = (tools.as_array_mut(), repo_tools.as_array()) {
            list.extend(extra.iter().cloned());
        }
    }

    tools
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
        "search_repo" => repo::search_repo(ctx, input).await,
        "read_file" => repo::read_file(ctx, input).await,
        "list_repo_files" => repo::list_repo_files(ctx, input).await,
        other => Err(DbError::new(
            DbErrorKind::Internal,
            format!("Unknown tool: {other}"),
        )),
    }
}

/// Pulls an optional string argument out of a tool's input object, treating
/// an empty or whitespace-only value as absent — models pass `""` for "not
/// applicable" often enough that it is worth normalizing here.
pub(crate) fn opt_arg_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn names(tools: &Value) -> Vec<String> {
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// The database tools are unconditional; the repository ones appear only
    /// when a repository is attached. Offering `search_repo` with nothing to
    /// search would just get it called and errored.
    #[test]
    fn repo_tools_appear_only_when_requested() {
        let without = names(&tool_definitions(false));
        assert!(without.contains(&"run_sql".to_string()));
        assert!(!without.iter().any(|n| n.starts_with("search_repo")));

        let with = names(&tool_definitions(true));
        for expected in ["search_repo", "read_file", "list_repo_files"] {
            assert!(with.contains(&expected.to_string()), "missing {expected}");
        }
        // The database tools keep their exact leading order, which is what
        // provider-side prompt caching reuses across turns.
        assert_eq!(&with[..without.len()], &without[..]);
    }

    /// Codex and OpenAI both map these definitions generically, reading
    /// `input_schema` off each entry — so a repo tool without one would reach
    /// the provider as a function with no parameters and be called wrong.
    #[test]
    fn every_tool_carries_a_name_description_and_schema() {
        for tool in tool_definitions(true).as_array().unwrap() {
            let name = tool["name"].as_str().expect("name");
            assert!(tool["description"].as_str().is_some_and(|d| d.len() > 40), "{name}");
            assert_eq!(tool["input_schema"]["type"], "object", "{name}");
            assert!(tool["input_schema"]["properties"].is_object(), "{name}");
            assert!(tool["input_schema"]["required"].is_array(), "{name}");
        }
    }
}
