//! System-prompt construction for the AI assistant.
//!
//! Split out from the agent loop because it's the highest-leverage part of
//! the feature and changes for entirely different reasons than the wire
//! protocol does.
//!
//! **Everything here must stay stable across the turns of one conversation.**
//! Provider prompt caching is prefix-based and the request clients put the
//! cache breakpoint on the system block, so a value that changes per request
//! (a timestamp, a session id, a row count) silently defeats the cache on
//! every single call. The one time-varying value included below is today's
//! *date*, which is stable for 24 hours — far longer than the cache's own
//! lifetime — so it costs nothing.

use std::collections::HashSet;

use crate::db::SchemaNode;

/// Above this many tables, the schema is rendered as a compact index and the
/// model is expected to pull detail on demand with `describe_table`.
///
/// Below it, full column detail is cheaper than the round trips it saves: a
/// small schema costs a few hundred tokens once (and then caches), whereas
/// making the model ask about every table it touches costs a request each
/// time. Above it, the full dump is both expensive and mostly irrelevant to
/// any single question. A table named by the active cubby (see
/// `PromptContext::cubby_tables`) is always rendered in full regardless of
/// this threshold — the user already told us it matters.
const COMPACT_SCHEMA_TABLE_THRESHOLD: usize = 30;

/// How many column names a compact-mode table line lists before eliding.
const COMPACT_SCHEMA_COLUMN_PREVIEW: usize = 6;

/// Everything the system prompt is built from. A struct rather than
/// positional arguments because these are all short strings and slices —
/// easy to transpose at a call site and impossible for the compiler to catch.
pub struct PromptContext<'a> {
    pub schema: &'a [SchemaNode],
    /// The table the user is looking at right now, if they're on a table tab.
    pub active_table: Option<(&'a str, &'a str)>,
    /// Tables the user explicitly attached as context via the AI panel's "+"
    /// button — independent of whatever tab happens to be active, and
    /// (unlike `active_table`) rendered in full schema detail regardless of
    /// `COMPACT_SCHEMA_TABLE_THRESHOLD`, same as the active cubby's tables.
    pub attached_tables: &'a [(&'a str, &'a str)],
    /// From `ConnectionInfo::server_version` — lets the model avoid syntax
    /// the user's actual server doesn't have.
    pub server_version: &'a str,
    pub connection_name: &'a str,
    /// The active cubby, if the user has one open — a named, curated subset
    /// of tables. `None` when no cubby is open; identical to today's
    /// behavior in that case.
    pub cubby: Option<CubbyContext<'a>>,
    /// The conversation's first user message, verbatim. Used only above
    /// `relevance::RANKED_SCHEMA_TABLE_THRESHOLD` tables, to rank which
    /// non-pinned tables are worth a line in the compact index — see
    /// `render_schema`. Deliberately the *first* message rather than the
    /// latest: it's the one value in this struct that would otherwise change
    /// every turn, and a changing system prompt defeats the provider's
    /// prefix-based cache on every single call. The first message is stable
    /// for the life of the conversation, so ranking off it keeps the prompt
    /// — and the cache hit — stable too.
    pub conversation_seed: &'a str,
}

/// The active cubby's contribution to the prompt: which tables it names,
/// rendered in full detail regardless of `COMPACT_SCHEMA_TABLE_THRESHOLD`.
pub struct CubbyContext<'a> {
    pub name: &'a str,
    pub tables: &'a [(String, String)],
}

pub fn build_system_prompt(ctx: &PromptContext) -> String {
    let mut out = String::with_capacity(4096);

    out.push_str(
        "You are the AI assistant built into CubbyDB, a desktop PostgreSQL client. \
         You help the user understand and query their database.\n\n",
    );

    // --- Context -----------------------------------------------------------
    out.push_str("## Context\n");
    out.push_str(&format!(
        "- Today's date: {}\n",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    out.push_str(&format!("- Database: PostgreSQL {}\n", ctx.server_version));
    out.push_str(&format!("- Connection: {}\n", ctx.connection_name));
    if let Some((schema_name, table_name)) = ctx.active_table {
        out.push_str(&format!(
            "- Currently viewing: {schema_name}.{table_name}\n"
        ));
    }
    if !ctx.attached_tables.is_empty() {
        let names: Vec<String> = ctx
            .attached_tables
            .iter()
            .map(|(s, t)| format!("{s}.{t}"))
            .collect();
        out.push_str(&format!("- Attached for context: {}\n", names.join(", ")));
    }
    out.push('\n');

    // --- Tools -------------------------------------------------------------
    // Phrased as *when* to reach for each, not just what each does — that
    // wording measurably improves how often a model picks the right tool.
    out.push_str(
        "## Tools\n\
         - `run_sql` — run exactly one read-only SELECT-family statement and see the results. Use it whenever the answer \
         depends on actual data rather than structure. Prefer running a query over guessing.\n\
         - `describe_table` — full detail for one table: every column with type, nullability and \
         default, plus indexes, check constraints, and foreign keys in both directions. Call this \
         before writing SQL against a table whose columns you have not already seen.\n\
         - `sample_rows` — a few real rows from a table. Use it when the shape or encoding of the \
         data matters: what a status column actually contains, how dates are stored, whether a \
         field is null in practice.\n\
         - `search_schema` — find tables and columns by name when you do not know where something \
         lives. Useful on large schemas where the list below is abbreviated.\n\
         - `explain_query` — the query plan for a statement. Use it for questions about \
         performance, index usage, or why something is slow.\n\n",
    );

    // --- Working rules -----------------------------------------------------
    out.push_str(
        "## Working rules\n\
         - Never invent a column or table name. If you are not certain something exists, call \
         `describe_table` or `search_schema` first.\n\
         - Schema-qualify every reference (`public.users`, not `users`).\n\
         - PostgreSQL folds unquoted identifiers to lowercase. Double-quote any identifier that is \
         mixed-case or contains special characters.\n\
         - Use `ILIKE` for case-insensitive text matching.\n\
         - Put a `LIMIT` on exploratory queries.\n\
         - Questions about dates and time are relative to today's date above, not to anything you \
         remember from training.\n\n",
    );

    // --- Writes ------------------------------------------------------------
    // Deliberately does not promise a write tool: there isn't one yet, and
    // naming a tool that doesn't exist just gets it called and errored.
    out.push_str(
        "## Changing data\n\
         You cannot modify this database. A hardcoded command allowlist accepts only one \
         SELECT-family statement, and PostgreSQL executes it inside a READ ONLY transaction that \
         is always rolled back. Never attempt or draft INSERT, UPDATE, DELETE, MERGE, DDL, session, \
         transaction, or administrative commands. If the user asks to change data or schema, say \
         that Ask AI is strictly read-only and offer a safe SELECT that previews the affected rows.\n\n",
    );

    // --- Style -------------------------------------------------------------
    out.push_str(
        "## Style\n\
         - Lead with the answer, then the supporting detail.\n\
         - Be concise. This is a narrow side panel, not a document.\n\
         - State any assumption you had to make about an ambiguous request.\n\
         - The user already sees every query you ran and its row count in the interface, so do not \
         repeat the SQL back to them in prose unless they asked to see it.\n\n",
    );

    // The panel renders GitHub-flavored Markdown, so this is about matching
    // what the renderer can actually show — and about keeping it restrained
    // enough to still read as a side panel rather than a report.
    out.push_str(
        "## Formatting\n\
         Your replies are rendered as GitHub-flavored Markdown in a narrow panel.\n\
         - Present row results as a Markdown table whenever there is more than one column or more \
         than one row. Tables scroll horizontally, so prefer a table over prose for anything \
         tabular.\n\
         - Keep a table to at most 10 rows. It is a preview: the interface labels it with the \
         real total (\"10 of 292 rows\") and its Download CSV button re-runs your query to export \
         every row, so nothing is lost by showing only a few. Never paste hundreds of rows into \
         the panel.\n\
         - Bold the specific values that answer the question, so the number or name the user asked \
         for stands out from the sentence around it.\n\
         - Use `backticks` for table, column, type, and value names in prose.\n\
         - Put SQL in a fenced ```sql block. The user gets Copy and Open-in-editor buttons on it.\n\
         - Use short bulleted lists for multiple findings. Skip headings unless the reply really \
         has several distinct sections.\n\
         - Never use emoji.\n\n",
    );

    out.push_str(
        "## Exporting\n\
         Every table you render carries a Download CSV button that exports the full result set, \
         at any size, in a file that opens directly in Excel. So when the user asks to export, \
         download, or \"get this as a CSV/Excel/spreadsheet\": run the query with `run_sql`, show \
         the first few rows as a table, and point them at that button. Size is never a reason to \
         refuse — a 300-row or 50,000-row export is the same one click. Never say you cannot \
         produce a file, and never ask them to run it in a tab instead.\n\
         For the download to cover everything, the turn needs exactly one `run_sql` call, and it \
         must select the full set — no LIMIT — since that same statement is what gets re-run on \
         export. Show only the first rows in the table; do not add a LIMIT to get there.\n\
         Render the data once, as that table. Do not also print it as CSV text, a fenced block, \
         or a prose list. A short sentence before it is enough.\n\n",
    );

    // --- Cubby ---------------------------------------------------------------
    // The user's own curation of what matters for this task. Placed right
    // before the schema so both sections of database context sit together.
    if let Some(cubby) = &ctx.cubby {
        out.push_str(&format!(
            "## Cubby: {}\n\
             The user is working inside this cubby — a named subset of the database for a \
             specific task. Its tables are rendered in full detail below regardless of the \
             schema's overall size, and the rest of the database is still fully reachable via \
             `search_schema` and `describe_table` if the question needs it.\n\n",
            cubby.name
        ));
    }

    // --- Schema ------------------------------------------------------------
    out.push_str("## Database\n");
    let cubby_tables: &[(String, String)] = ctx.cubby.as_ref().map_or(&[], |c| c.tables);
    let mut pinned_tables: Vec<(&str, &str)> =
        cubby_tables.iter().map(|(s, t)| (s.as_str(), t.as_str())).collect();
    pinned_tables.extend(ctx.attached_tables.iter().copied());
    render_schema(&mut out, ctx.schema, &pinned_tables, ctx.conversation_seed);

    out
}

/// Renders the schema at whichever level of detail fits its size. See
/// `COMPACT_SCHEMA_TABLE_THRESHOLD` and `relevance::RANKED_SCHEMA_TABLE_THRESHOLD`.
/// `pinned_tables` are always rendered in full even when the schema as a
/// whole is over threshold — the user already told us these specific tables
/// matter for the task at hand. That's the active cubby's tables plus any
/// explicitly-attached ones for the chat prompt, and the table being
/// filtered for `filter.rs`'s. `seed` is free text used only in the ranked
/// tier — see `PromptContext::conversation_seed`.
pub fn render_schema(out: &mut String, schema: &[SchemaNode], pinned_tables: &[(&str, &str)], seed: &str) {
    let table_count: usize = schema.iter().map(|s| s.tables.len()).sum();
    let pinned: HashSet<(&str, &str)> = pinned_tables.iter().copied().collect();

    if table_count > crate::ai::relevance::RANKED_SCHEMA_TABLE_THRESHOLD {
        let relevant = crate::ai::relevance::select_relevant_tables(
            schema,
            &pinned,
            seed,
            crate::ai::relevance::RANKED_SCHEMA_TABLE_LIMIT,
        );
        let mut body = String::new();
        let mut shown = 0usize;
        for s in schema {
            for t in &s.tables {
                let key = (s.name.as_str(), t.name.as_str());
                if pinned.contains(&key) {
                    render_table_full(&mut body, &s.name, t);
                    shown += 1;
                } else if relevant.contains(&key) {
                    render_table_compact(&mut body, &s.name, t);
                    shown += 1;
                }
            }
        }
        out.push_str(&format!(
            "{table_count} tables — too many to list here even abbreviated. Showing the {shown} \
             most relevant to this conversation: tables named or attached above, tables whose name \
             or columns match what was asked, and their direct foreign-key neighbors. Call \
             `search_schema` to find any other table by name, then `describe_table` for its full \
             detail.\n\n"
        ));
        out.push_str(&body);
    } else if table_count > COMPACT_SCHEMA_TABLE_THRESHOLD {
        out.push_str(&format!(
            "{table_count} tables. Abbreviated below — call `describe_table` for full detail on \
             any one of them. Tables named by the active cubby or attached for context above are \
             rendered in full here already.\n\n"
        ));
        for s in schema {
            for t in &s.tables {
                if pinned.contains(&(s.name.as_str(), t.name.as_str())) {
                    render_table_full(out, &s.name, t);
                } else {
                    render_table_compact(out, &s.name, t);
                }
            }
        }
    } else {
        for s in schema {
            for t in &s.tables {
                render_table_full(out, &s.name, t);
            }
        }
    }

    render_enums(out, schema);
}

/// Full detail: every column, with PK and FK markers.
fn render_table_full(out: &mut String, schema_name: &str, t: &crate::db::TableNode) {
    let kind = match t.kind {
        crate::db::TableKind::View => " (view)",
        crate::db::TableKind::Table => "",
    };
    out.push_str(&format!("\n{}.{}{}", schema_name, t.name, kind));
    if let Some(rows) = t.estimated_rows {
        out.push_str(&format!(" — ~{rows} rows"));
    }
    out.push('\n');
    for c in &t.columns {
        out.push_str(&format!("  {} {}", c.name, c.data_type));
        if c.is_primary_key {
            out.push_str(" PK");
        }
        if !c.nullable {
            out.push_str(" NOT NULL");
        }
        for r in &c.references {
            out.push_str(&format!(" -> {}.{}.{}", r.schema, r.table, r.column));
        }
        out.push('\n');
    }
}

/// One line per table: enough to know it exists and roughly what it holds,
/// cheap enough to list hundreds of them.
fn render_table_compact(out: &mut String, schema_name: &str, t: &crate::db::TableNode) {
    out.push_str(&format!("- {}.{}", schema_name, t.name));
    if let Some(rows) = t.estimated_rows {
        out.push_str(&format!(" (~{rows} rows, {} cols)", t.columns.len()));
    } else {
        out.push_str(&format!(" ({} cols)", t.columns.len()));
    }
    out.push_str(": ");

    let shown: Vec<String> = t
        .columns
        .iter()
        .take(COMPACT_SCHEMA_COLUMN_PREVIEW)
        .map(|c| {
            let mut label = c.name.clone();
            if c.is_primary_key {
                label.push_str(" PK");
            }
            // FK targets earn their tokens even in compact mode — they're how
            // the model works out which tables join to which without a call.
            if let Some(r) = c.references.first() {
                label.push_str(&format!(" -> {}.{}", r.table, r.column));
            }
            label
        })
        .collect();
    out.push_str(&shown.join(", "));
    if t.columns.len() > COMPACT_SCHEMA_COLUMN_PREVIEW {
        out.push_str(&format!(
            ", … {} more",
            t.columns.len() - COMPACT_SCHEMA_COLUMN_PREVIEW
        ));
    }
    out.push('\n');
}

/// Enum types are listed at both detail levels: they're small, and knowing
/// the legal values of a status column is often the whole answer to a
/// question. `fetch_schema` already collects them.
fn render_enums(out: &mut String, schema: &[SchemaNode]) {
    let has_enums = schema.iter().any(|s| !s.types.is_empty());
    if !has_enums {
        return;
    }
    out.push_str("\nEnum types:\n");
    for s in schema {
        for ty in &s.types {
            out.push_str(&format!(
                "- {}.{}: {}\n",
                s.name,
                ty.name,
                ty.values.join(", ")
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ColumnNode, TableKind, TableNode};

    fn column(name: &str) -> ColumnNode {
        ColumnNode {
            name: name.to_string(),
            data_type: "text".to_string(),
            nullable: true,
            is_primary_key: false,
            references: vec![],
            referenced_by: vec![],
        }
    }

    fn table(name: &str, columns: usize) -> TableNode {
        TableNode {
            name: name.to_string(),
            kind: TableKind::Table,
            estimated_rows: None,
            columns: (0..columns).map(|i| column(&format!("col_{i}"))).collect(),
        }
    }

    fn schema(name: &str, tables: Vec<TableNode>) -> SchemaNode {
        SchemaNode { name: name.to_string(), tables, functions: vec![], sequences: vec![], types: vec![] }
    }

    fn base_ctx<'a>(schema: &'a [SchemaNode]) -> PromptContext<'a> {
        PromptContext {
            schema,
            active_table: None,
            attached_tables: &[],
            server_version: "16.2",
            connection_name: "test",
            cubby: None,
            conversation_seed: "",
        }
    }

    #[test]
    fn mentions_the_currently_viewed_table() {
        let schemas = vec![schema("public", vec![table("orders", 2)])];
        let mut ctx = base_ctx(&schemas);
        ctx.active_table = Some(("public", "orders"));
        let prompt = build_system_prompt(&ctx);
        assert!(prompt.contains("Currently viewing: public.orders"));
    }

    #[test]
    fn omits_attached_line_when_nothing_is_attached() {
        let schemas = vec![schema("public", vec![table("orders", 2)])];
        let prompt = build_system_prompt(&base_ctx(&schemas));
        assert!(!prompt.contains("Attached for context"));
    }

    #[test]
    fn lists_every_attached_table() {
        let schemas = vec![schema("public", vec![table("orders", 2), table("users", 2)])];
        let mut ctx = base_ctx(&schemas);
        ctx.attached_tables = &[("public", "orders"), ("public", "users")];
        let prompt = build_system_prompt(&ctx);
        assert!(prompt.contains("Attached for context: public.orders, public.users"));
    }

    #[test]
    fn attached_table_is_rendered_in_full_detail_above_the_compact_threshold() {
        let mut tables: Vec<TableNode> =
            (0..COMPACT_SCHEMA_TABLE_THRESHOLD + 1).map(|i| table(&format!("t{i}"), 1)).collect();
        tables.push(table("important", 3));
        let schemas = vec![schema("public", tables)];

        let mut ctx = base_ctx(&schemas);
        ctx.attached_tables = &[("public", "important")];
        let prompt = build_system_prompt(&ctx);

        // Full-detail rendering puts the table on its own line followed by
        // one indented "name type" line per column; the compact form lists
        // an unpinned table's columns inline after ": " with no data type.
        assert!(prompt.contains("\npublic.important\n  col_0 text\n  col_1 text\n  col_2 text\n"));
        assert!(prompt.contains("public.t0 (1 cols): col_0"));
        assert!(!prompt.contains("public.t0\n  col_0 text"));
    }

    #[test]
    fn cubby_and_attached_tables_are_both_pinned_to_full_detail() {
        let mut tables: Vec<TableNode> =
            (0..COMPACT_SCHEMA_TABLE_THRESHOLD + 1).map(|i| table(&format!("t{i}"), 1)).collect();
        tables.push(table("cubby_table", 1));
        tables.push(table("attached_table", 1));
        let schemas = vec![schema("public", tables)];
        let cubby_tables = vec![("public".to_string(), "cubby_table".to_string())];

        let mut ctx = base_ctx(&schemas);
        ctx.attached_tables = &[("public", "attached_table")];
        ctx.cubby = Some(CubbyContext { name: "My Cubby", tables: &cubby_tables });
        let prompt = build_system_prompt(&ctx);

        assert!(prompt.contains("\npublic.cubby_table\n  col_0 text\n"));
        assert!(prompt.contains("\npublic.attached_table\n  col_0 text\n"));
    }

    #[test]
    fn above_ranked_threshold_only_relevant_tables_are_rendered() {
        let threshold = crate::ai::relevance::RANKED_SCHEMA_TABLE_THRESHOLD;
        let mut tables: Vec<TableNode> =
            (0..threshold + 1).map(|i| table(&format!("unrelated_widget_{i}"), 1)).collect();
        tables.push(table("customer_orders", 1));
        let schemas = vec![schema("public", tables)];

        let mut ctx = base_ctx(&schemas);
        ctx.conversation_seed = "show me recent customer orders";
        let prompt = build_system_prompt(&ctx);

        assert!(prompt.contains("too many to list here"));
        assert!(prompt.contains("public.customer_orders"));
    }

    #[test]
    fn ranked_tier_still_renders_pinned_tables_in_full_detail() {
        let threshold = crate::ai::relevance::RANKED_SCHEMA_TABLE_THRESHOLD;
        let mut tables: Vec<TableNode> =
            (0..threshold + 1).map(|i| table(&format!("unrelated_widget_{i}"), 1)).collect();
        tables.push(table("attached_table", 3));
        let schemas = vec![schema("public", tables)];

        let mut ctx = base_ctx(&schemas);
        ctx.attached_tables = &[("public", "attached_table")];
        ctx.conversation_seed = "unrelated question about nothing in particular";
        let prompt = build_system_prompt(&ctx);

        assert!(prompt.contains("\npublic.attached_table\n  col_0 text\n  col_1 text\n  col_2 text\n"));
    }

    #[test]
    fn below_ranked_threshold_behaves_exactly_as_the_plain_compact_tier() {
        let tables: Vec<TableNode> =
            (0..COMPACT_SCHEMA_TABLE_THRESHOLD + 1).map(|i| table(&format!("t{i}"), 1)).collect();
        let schemas = vec![schema("public", tables.clone())];

        let mut ctx = base_ctx(&schemas);
        ctx.conversation_seed = "irrelevant text that would otherwise change ranking";
        let prompt = build_system_prompt(&ctx);

        // Every table still appears, unranked — the seed only matters once
        // the ranked tier's own (much higher) threshold is crossed.
        for t in &tables {
            assert!(prompt.contains(&format!("public.{} (1 cols)", t.name)));
        }
    }
}
