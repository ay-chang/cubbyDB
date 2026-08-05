//! Tools that execute SQL: `run_sql` and `explain_query`.

use serde_json::Value;

use super::{arg_str, ToolContext, ToolOutcome};
use crate::ai::{summarize_for_model, ToolTrace};
use crate::db::DbError;

pub async fn run_sql(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let sql = arg_str(input, "sql")?;
    let result = ctx.db.run_query(&sql).await?;
    Ok(ToolOutcome {
        content: summarize_for_model(&result),
        trace: ToolTrace {
            tool: "run_sql".to_string(),
            detail: sql,
            row_count: Some(result.row_count as i64),
            error: None,
        },
    })
}

/// `EXPLAIN` the given statement, optionally with `ANALYZE`.
///
/// `ANALYZE` genuinely executes the statement — that is the whole point of
/// it, and it is why this must go through `run_read_only_query` like every
/// other tool here. Inside the read-only transaction an `EXPLAIN ANALYZE
/// UPDATE …` is rejected by PostgreSQL rather than quietly performing the
/// update. (The SQL editor's own Cmd+Shift+A shortcut routes through the
/// read-*write* path instead; that is a deliberate difference — there a human
/// typed the statement.)
pub async fn explain_query(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let sql = arg_str(input, "sql")?;
    let analyze = input
        .get("analyze")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let options = if analyze { "ANALYZE, FORMAT JSON" } else { "FORMAT JSON" };
    let explain_sql = format!("EXPLAIN ({options}) {sql}");

    let result = ctx.db.run_query(&explain_sql).await?;
    Ok(ToolOutcome {
        content: summarize_for_model(&result),
        trace: ToolTrace {
            tool: "explain_query".to_string(),
            detail: explain_sql,
            row_count: None,
            error: None,
        },
    })
}
