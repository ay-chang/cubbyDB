//! Tools that answer questions about structure rather than data:
//! `describe_table`, `sample_rows`, `search_schema`.

use serde_json::Value;

use super::{arg_str, ToolContext, ToolOutcome};
use crate::ai::{summarize_for_model, ToolTrace};
use crate::db::DbError;

/// Hard ceiling on `sample_rows`, independent of what the model asks for.
/// Sample rows exist to show the *shape* of the data; more than this is
/// a `run_sql` call wearing a disguise, and it costs context on every
/// subsequent turn of the conversation.
const MAX_SAMPLE_ROWS: u32 = 20;
const DEFAULT_SAMPLE_ROWS: u32 = 5;

/// How many matches `search_schema` returns before truncating.
const MAX_SEARCH_RESULTS: usize = 40;

/// Everything about one table: columns with defaults, indexes, check
/// constraints, and foreign keys in both directions.
///
/// Two sources, deliberately: `table_structure` supplies defaults, indexes
/// and check constraints (which the schema tree does not carry), while the
/// tree supplies the foreign-key graph (which `table_structure` does not).
/// Merging them here is cheaper than a new catalog round trip for either.
///
/// Not yet included: table and column comments (`obj_description` /
/// `col_description`). They would be genuinely useful — a human-written note
/// on what a column means is exactly the context a model lacks — but nothing
/// in the app reads them today, so they need new catalog SQL in the `db`
/// layer rather than an ad-hoc query from up here.
pub async fn describe_table(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let schema_name = arg_str(input, "schema")?;
    let table_name = arg_str(input, "table")?;

    let structure = ctx
        .session
        .table_structure(&schema_name, &table_name)
        .await?;

    let mut out = format!("{schema_name}.{table_name}\n\nColumns:\n");
    for c in &structure.columns {
        out.push_str(&format!("  {} {}", c.name, c.data_type));
        if c.is_primary_key {
            out.push_str(" PK");
        }
        if !c.nullable {
            out.push_str(" NOT NULL");
        }
        if let Some(default) = &c.default_expr {
            out.push_str(&format!(" DEFAULT {default}"));
        }
        out.push('\n');
    }

    // FK edges, both directions, from the tree the frontend already sent.
    let table = ctx
        .schema
        .iter()
        .find(|s| s.name == schema_name)
        .and_then(|s| s.tables.iter().find(|t| t.name == table_name));

    if let Some(t) = table {
        let mut outgoing = Vec::new();
        let mut incoming = Vec::new();
        for c in &t.columns {
            for r in &c.references {
                outgoing.push(format!("  {} -> {}.{}.{}", c.name, r.schema, r.table, r.column));
            }
            for r in &c.referenced_by {
                incoming.push(format!("  {}.{}.{} -> {}", r.schema, r.table, r.column, c.name));
            }
        }
        if !outgoing.is_empty() {
            out.push_str("\nForeign keys out:\n");
            out.push_str(&outgoing.join("\n"));
            out.push('\n');
        }
        if !incoming.is_empty() {
            out.push_str("\nReferenced by:\n");
            out.push_str(&incoming.join("\n"));
            out.push('\n');
        }
        if let Some(rows) = t.estimated_rows {
            out.push_str(&format!("\nEstimated rows: ~{rows}\n"));
        }
    }

    if !structure.indexes.is_empty() {
        out.push_str("\nIndexes:\n");
        for i in &structure.indexes {
            out.push_str(&format!("  {}\n", i.definition));
        }
    }

    if !structure.check_constraints.is_empty() {
        out.push_str("\nCheck constraints:\n");
        for c in &structure.check_constraints {
            out.push_str(&format!("  {} {}\n", c.name, c.definition));
        }
    }

    Ok(ToolOutcome {
        content: out,
        trace: ToolTrace {
            tool: "describe_table".to_string(),
            detail: format!("{schema_name}.{table_name}"),
            row_count: None,
            error: None,
        },
    })
}

/// A handful of real rows.
///
/// The SQL comes from `select_top_sql` (the same builder the table browser
/// uses) with `filter: None` — that argument is interpolated into the
/// statement verbatim, so it must never carry anything the model supplied.
/// A model that wants filtered rows should call `run_sql`, where the whole
/// statement goes through the read-only transaction as one unit.
pub async fn sample_rows(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let schema_name = arg_str(input, "schema")?;
    let table_name = arg_str(input, "table")?;
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| (n as u32).clamp(1, MAX_SAMPLE_ROWS))
        .unwrap_or(DEFAULT_SAMPLE_ROWS);

    let sql = ctx
        .session
        .select_top_sql(&schema_name, &table_name, None, limit, 0, None);
    let result = ctx.session.run_read_only_query(&sql).await?;

    Ok(ToolOutcome {
        content: summarize_for_model(&result),
        trace: ToolTrace {
            tool: "sample_rows".to_string(),
            detail: format!("{schema_name}.{table_name} ({limit} rows)"),
            row_count: Some(result.row_count as i64),
            error: None,
        },
    })
}

/// Substring search over table and column names. Pure in-memory over the
/// schema tree that came with the turn — no database round trip, so it is
/// effectively free and safe to call speculatively.
pub fn search_schema(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let query = arg_str(input, "query")?;
    let needle = query.to_lowercase();

    let mut matches = Vec::new();
    for s in ctx.schema {
        for t in &s.tables {
            if t.name.to_lowercase().contains(&needle) {
                matches.push(format!(
                    "table {}.{} ({} cols)",
                    s.name,
                    t.name,
                    t.columns.len()
                ));
            }
            for c in &t.columns {
                if c.name.to_lowercase().contains(&needle) {
                    matches.push(format!(
                        "column {}.{}.{} {}",
                        s.name, t.name, c.name, c.data_type
                    ));
                }
            }
        }
    }

    let total = matches.len();
    matches.truncate(MAX_SEARCH_RESULTS);

    let content = if total == 0 {
        format!("No tables or columns matching \"{query}\".")
    } else {
        let mut out = matches.join("\n");
        if total > MAX_SEARCH_RESULTS {
            out.push_str(&format!(
                "\n… {} more matches not shown; narrow the search.",
                total - MAX_SEARCH_RESULTS
            ));
        }
        out
    };

    Ok(ToolOutcome {
        content,
        trace: ToolTrace {
            tool: "search_schema".to_string(),
            detail: query,
            row_count: Some(total as i64),
            error: None,
        },
    })
}
