//! Natural-language -> WHERE predicate for the table browser's filter bar.
//!
//! The filter bar's AI mode is a *one-shot* use of the same agent the chat
//! panel runs: same providers, same key/model settings, same read-only tool
//! surface. Only two things differ, and both live here — a system prompt
//! aimed at a single table and a single sentence of output, and a parser
//! that turns whatever the model actually said back into a bare predicate.
//!
//! It deliberately produces raw SQL rather than a structured
//! column/operator/value triple. The filter bar already *is* a SQL predicate
//! field (see `FilterBar.tsx`), so a predicate drops straight into it, stays
//! editable by hand afterwards, and can express things a structured filter
//! cannot — `OR` groups, `IS NOT NULL`, date arithmetic, a subquery against
//! a related table.
//!
//! Like `prompt.rs`, everything built here must be stable across the calls
//! of one session for provider prompt caching to hit: the only time-varying
//! value is today's date.

use serde::Serialize;

use crate::db::SchemaNode;

/// Everything the filter prompt is built from.
pub struct FilterPromptContext<'a> {
    pub schema: &'a [SchemaNode],
    /// The table the filter bar belongs to — the only table the predicate is
    /// evaluated against.
    pub table: (&'a str, &'a str),
    pub server_version: &'a str,
    /// Whatever is already in the filter bar, if anything. The model is told
    /// it may refine it rather than always starting from scratch — the same
    /// affordance conar's filter bar gives its structured filters.
    pub current_filter: Option<&'a str>,
}

/// What the frontend gets back: the predicate to drop into the filter bar,
/// plus an optional one-line note for anything the predicate itself can't
/// carry (an assumption made, or why nothing could be generated).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFilterResult {
    pub where_clause: String,
    pub note: Option<String>,
}

pub fn build_filter_prompt(ctx: &FilterPromptContext) -> String {
    let (schema_name, table_name) = ctx.table;
    let mut out = String::with_capacity(4096);

    out.push_str(
        "You turn a natural-language description into a single PostgreSQL WHERE predicate for \
         one table in CubbyDB, a desktop PostgreSQL client. The user typed the description into \
         the table browser's filter bar; your predicate is substituted directly into\n\n\
         \x20   SELECT * FROM <table> WHERE <your predicate>\n\n\
         and the resulting rows are what they see.\n\n",
    );

    out.push_str("## Context\n");
    out.push_str(&format!(
        "- Today's date: {}\n",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    out.push_str(&format!("- Database: PostgreSQL {}\n", ctx.server_version));
    out.push_str(&format!("- Filtering: {schema_name}.{table_name}\n"));
    match ctx.current_filter {
        Some(current) if !current.trim().is_empty() => {
            out.push_str(&format!(
                "- Filter currently in the bar: {}\n  Treat it as a starting point: if the \
                 request reads like a refinement (\"…and only paid ones\", \"drop the date \
                 part\"), build on it. If it reads like a fresh request, replace it. Your \
                 predicate always replaces the current one wholesale — it is never appended \
                 to.\n",
                current.trim()
            ));
        }
        _ => {}
    }
    out.push('\n');

    // --- Output contract ---------------------------------------------------
    // Stated before anything else the model has to weigh, and stated as the
    // exact bytes to emit: this is the one instruction that makes the reply
    // usable at all, and `parse_reply` below is a safety net, not the plan.
    out.push_str(
        "## Reply format\n\
         Reply with a JSON object and nothing else — no prose around it, no markdown fence:\n\n\
         {\"where\": \"<predicate>\", \"note\": \"<optional one-line note, or omit>\"}\n\n\
         - `where` is only the text that follows `WHERE`. Do not include the keyword `WHERE`, a \
         `SELECT`, an `ORDER BY`, a `LIMIT`, or a trailing semicolon.\n\
         - `note` is for the one thing the predicate itself cannot say: an assumption you had to \
         make, or — with `where` set to an empty string — why the request could not be turned \
         into a filter. Leave it out when the predicate speaks for itself. One short sentence, \
         no more.\n\n",
    );

    // --- Rules -------------------------------------------------------------
    out.push_str(&format!(
        "## Writing the predicate\n\
         - Only columns of {schema_name}.{table_name} are in scope unqualified. Never invent a \
         column: if the request names something with no matching column, return an empty \
         `where` and say so in `note`.\n\
         - PostgreSQL folds unquoted identifiers to lowercase. Double-quote any identifier that \
         is mixed-case or contains special characters.\n\
         - Match text case-insensitively with `ILIKE` unless the user clearly wants an exact \
         match. For \"contains\"-style wording use `ILIKE '%term%'`.\n\
         - Quote string and date literals with single quotes; escape an embedded quote by \
         doubling it. Cast where the type needs it (`created_at >= '2024-01-01'::date`).\n\
         - Resolve relative dates (\"last week\", \"this month\", \"in the last 30 days\") \
         against today's date above — never against anything remembered from training. Prefer \
         half-open ranges over `BETWEEN` for timestamps, so a `timestamptz` on the final day is \
         not silently excluded.\n\
         - \"Empty\" is ambiguous for a nullable text column: cover both, e.g. \
         `(note IS NULL OR note = '')`.\n\
         - Combine multiple conditions with `AND` unless the request is clearly alternative. \
         Parenthesize any `OR` group you mix with an `AND`.\n\
         - A subquery against another table in the schema below is allowed, and is the right \
         answer when the request filters by something that lives one join away \
         (`user_id IN (SELECT id FROM public.users WHERE …)`). Schema-qualify every table inside \
         a subquery.\n\
         - The predicate must be read-only. Never call a function that writes, and never attempt \
         to close the statement and start another one.\n\
         - Sorting, row limits, aggregation, and column selection are outside a WHERE predicate. \
         Filter as close as you can to what was asked and mention the dropped part in `note`.\n\n",
    ));

    // --- Tools -------------------------------------------------------------
    // The same read-only tool surface the chat panel has. Framed as an
    // exception rather than a step, because this runs in a filter bar where
    // a round trip the user did not need is felt immediately.
    out.push_str(
        "## Tools\n\
         The table's full column list is below and is usually all you need — answer in one turn \
         from it whenever you can. Reach for a tool only when the predicate depends on how \
         values are actually *encoded* and the schema cannot tell you: whether a status column \
         holds `cancelled` or `CANCELLED`, how a free-text field spells a category. \
         `sample_rows` answers that in one call. `run_sql` (read-only, always rolled back), \
         `describe_table`, and `search_schema` are also available; `search_schema` is how you \
         find a table the abbreviated listing below only names.\n\n",
    );

    // --- Examples ----------------------------------------------------------
    // Two examples, both showing the exact reply bytes: one ordinary, one
    // refusal. The refusal case is the one models get wrong without a
    // demonstration — they invent a plausible column instead.
    out.push_str(
        "## Examples\n\
         Request: \"signed up this year and still active\"\n\
         {\"where\": \"created_at >= date_trunc('year', current_date) AND status = 'active'\"}\n\n\
         Request: \"orders over $100 from last week\"\n\
         {\"where\": \"total > 100 AND placed_at >= current_date - interval '7 days'\", \
         \"note\": \"Read \\\"last week\\\" as the last 7 days.\"}\n\n\
         Request: \"the ones flagged by the moderator\"\n\
         {\"where\": \"\", \"note\": \"No column on this table records moderator flags.\"}\n\n",
    );

    // --- Schema ------------------------------------------------------------
    // The filtered table is pinned to full detail; the rest of the database
    // is rendered exactly as the chat panel renders it, so a subquery has
    // something to aim at.
    out.push_str("## Database\n");
    crate::ai::prompt::render_schema(&mut out, ctx.schema, &[(schema_name, table_name)]);

    out
}

/// Turns a model reply into a predicate.
///
/// The prompt asks for bare JSON, and the happy path is exactly that. The
/// fallbacks below exist because the cost of a mis-parse here is the feature
/// silently doing nothing: a model that wraps its JSON in a ```json fence, or
/// that answers with the predicate as plain text, is still answering
/// correctly — only the packaging is off, and unwrapping it is a few lines.
pub fn parse_reply(reply: &str) -> AiFilterResult {
    let text = strip_code_fence(reply.trim());

    // Bare JSON, or JSON with a stray sentence around it — take the outermost
    // braces rather than requiring the whole reply to parse.
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if start < end {
            if let Ok(parsed) = serde_json::from_str::<ReplyShape>(&text[start..=end]) {
                return AiFilterResult {
                    where_clause: clean_predicate(&parsed.where_clause.unwrap_or_default()),
                    note: clean_note(parsed.note),
                };
            }
        }
    }

    // No JSON at all: treat the whole reply as the predicate, but only if it
    // is short enough to plausibly be one. A model that answered in prose has
    // not given us a filter, and pasting a paragraph into the bar is worse
    // than reporting that nothing came back.
    let predicate = clean_predicate(text);
    if predicate.is_empty() || predicate.len() > 2000 || predicate.contains('\n') {
        return AiFilterResult {
            where_clause: String::new(),
            note: Some("The AI didn't return a usable filter — try rewording the request.".into()),
        };
    }
    AiFilterResult {
        where_clause: predicate,
        note: None,
    }
}

#[derive(serde::Deserialize)]
struct ReplyShape {
    /// `where` is a Rust keyword, hence the rename. Optional so a reply that
    /// only carries a `note` (the "cannot filter" case, where some models
    /// omit the empty string rather than sending it) still parses.
    #[serde(rename = "where")]
    where_clause: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// Removes a surrounding ```/```sql/```json fence, if the model added one.
fn strip_code_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    // The opening fence's info string (`sql`, `json`, or nothing) runs to the
    // end of that line.
    let body = match rest.find('\n') {
        Some(nl) => &rest[nl + 1..],
        None => return text,
    };
    body.trim_end()
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(text)
}

/// Normalizes a predicate into what the filter bar expects: no leading
/// `WHERE`, no trailing semicolon, no surrounding whitespace. Models comply
/// with "omit the keyword" most of the time, and stripping the exception is
/// cheaper than a retry.
fn clean_predicate(raw: &str) -> String {
    let mut out = raw.trim();
    if out.len() >= 5 && out[..5].eq_ignore_ascii_case("where") {
        // Only when it really is the keyword — `where_clause = 1` is a column
        // name that happens to start with the same five letters.
        let rest = &out[5..];
        if rest.starts_with(|c: char| c.is_whitespace()) {
            out = rest.trim_start();
        }
    }
    out.trim_end().trim_end_matches(';').trim().to_string()
}

fn clean_note(note: Option<String>) -> Option<String> {
    note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_json() {
        let r = parse_reply(r#"{"where": "id = 1", "note": null}"#);
        assert_eq!(r.where_clause, "id = 1");
        assert_eq!(r.note, None);
    }

    #[test]
    fn parses_fenced_json() {
        let r = parse_reply("```json\n{\"where\": \"status = 'active'\"}\n```");
        assert_eq!(r.where_clause, "status = 'active'");
    }

    #[test]
    fn keeps_the_note() {
        let r = parse_reply(r#"{"where": "", "note": "No such column."}"#);
        assert_eq!(r.where_clause, "");
        assert_eq!(r.note.as_deref(), Some("No such column."));
    }

    #[test]
    fn falls_back_to_plain_predicate() {
        let r = parse_reply("WHERE total > 100;");
        assert_eq!(r.where_clause, "total > 100");
    }

    #[test]
    fn keeps_a_column_named_like_the_keyword() {
        let r = parse_reply(r#"{"where": "wherever = 'x'"}"#);
        assert_eq!(r.where_clause, "wherever = 'x'");
    }

    #[test]
    fn rejects_prose() {
        let r = parse_reply(
            "I'm not sure which column you mean here.\nCould you clarify what you're after?",
        );
        assert_eq!(r.where_clause, "");
        assert!(r.note.is_some());
    }
}
