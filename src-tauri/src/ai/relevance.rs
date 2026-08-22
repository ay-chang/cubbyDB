//! Keyword-overlap relevance scoring, shared by `prompt::render_schema`'s
//! ranked tier (for schemas too large to list in full even in compact form)
//! and `tools::schema::search_schema` (so a multi-word query like "customer
//! orders" — which never appears as a literal substring in an identifier —
//! still finds `cust_ord_hdr`).
//!
//! Deliberately not semantic/embedding-based. Table and column *names*
//! already share substrings even when abbreviated (`cust_ord` contains
//! `ord`), so keyword overlap over identifier tokens gets most of the value
//! an embedding search would, without a network call, a bundled model, or
//! sending a user's schema names to a third party. If that ever proves too
//! weak in practice, this module is the one place a real embedding lookup
//! would slot in later — everything above it already asks in terms of
//! "which tables are relevant", not "compare these strings".

use std::collections::HashSet;

use crate::db::SchemaNode;

/// Above this many tables, `render_schema` stops listing every table (even
/// in compact form) and instead ranks them against the conversation.
pub const RANKED_SCHEMA_TABLE_THRESHOLD: usize = 200;

/// How many non-pinned tables the ranked tier keeps.
pub const RANKED_SCHEMA_TABLE_LIMIT: usize = 150;

const NAME_TOKEN_MATCH: i32 = 3;
const NAME_PARTIAL_MATCH: i32 = 2;
const COLUMN_TOKEN_MATCH: i32 = 1;
/// Tables one foreign key hop from a pinned table are usually the join
/// target a question about that table needs next, regardless of whether
/// they share any vocabulary with what was actually typed.
const FK_ADJACENCY_BONUS: i32 = 4;

/// Words too common in either schema vocabulary or ordinary requests to mean
/// anything on their own — matching on them would rank nearly every table.
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "is", "are", "id", "at", "by",
    "with", "me", "my", "show", "get", "list", "all", "table", "tables", "column", "columns",
];

/// Chooses which non-pinned tables earn a line in the ranked compact index.
/// Returns their `(schema, table)` identity; membership only — the caller
/// still renders in schema order. `pinned` tables are never scored or
/// returned, since the caller already renders them in full separately.
///
/// Falls back to a stable, deterministic (if not particularly meaningful)
/// selection when `seed` has no usable words: every table then scores 0
/// except FK neighbors of a pinned table, so the ordering falls through to
/// the tie-break and the first `limit` tables by name are kept. That only
/// happens if the caller passes an empty seed; both call sites (a chat's
/// first user message, a filter's request text) guarantee a non-empty one
/// in practice.
pub fn select_relevant_tables<'a>(
    schema: &'a [SchemaNode],
    pinned: &HashSet<(&str, &str)>,
    seed: &str,
    limit: usize,
) -> HashSet<(&'a str, &'a str)> {
    let seed_tokens: HashSet<String> =
        tokenize(seed).into_iter().filter(|t| !is_stopword(t)).collect();
    let fk_adjacent = fk_adjacent_to(schema, pinned);

    let mut scored: Vec<((&str, &str), i32)> = Vec::new();
    for s in schema {
        for t in &s.tables {
            let key = (s.name.as_str(), t.name.as_str());
            if pinned.contains(&key) {
                continue;
            }
            let mut score = if fk_adjacent.contains(&key) { FK_ADJACENCY_BONUS } else { 0 };
            score += token_overlap_score(
                &identifier_tokens(&t.name),
                &seed_tokens,
                NAME_TOKEN_MATCH,
                NAME_PARTIAL_MATCH,
            );
            for c in &t.columns {
                score += token_overlap_score(
                    &identifier_tokens(&c.name),
                    &seed_tokens,
                    COLUMN_TOKEN_MATCH,
                    0,
                );
            }
            scored.push((key, score));
        }
    }

    // Highest score first; ties broken by name so the selection — and
    // therefore the cached prompt prefix — doesn't reorder itself between
    // otherwise-identical calls.
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored.into_iter().take(limit).map(|(key, _)| key).collect()
}

/// One match's score against a free-text query, or `None` if it doesn't
/// match at all. Shared by `search_schema`: an exact or substring hit still
/// wins outright (score above anything token-based can reach), so existing
/// single-word substring searches behave exactly as before — this only adds
/// a second tier underneath for multi-word and abbreviated queries that
/// never had a literal substring to find in the first place.
pub fn match_score(identifier: &str, query_lower: &str, query_tokens: &[String]) -> Option<i32> {
    let identifier_lower = identifier.to_lowercase();
    if identifier_lower == query_lower {
        return Some(1000);
    }
    if !query_lower.is_empty() && identifier_lower.contains(query_lower) {
        return Some(500);
    }
    let id_tokens = identifier_tokens(identifier);
    let mut score = 0;
    for qt in query_tokens {
        if id_tokens.iter().any(|it| it == qt) {
            score += 20;
        } else if qt.len() >= 3
            && id_tokens
                .iter()
                .any(|it| it.len() >= 3 && (it.starts_with(qt.as_str()) || qt.starts_with(it.as_str())))
        {
            score += 10;
        }
    }
    if score > 0 {
        Some(score)
    } else {
        None
    }
}

fn token_overlap_score(
    id_tokens: &[String],
    seed_tokens: &HashSet<String>,
    exact: i32,
    partial: i32,
) -> i32 {
    let mut score = 0;
    for tok in id_tokens {
        if seed_tokens.contains(tok) {
            score += exact;
        } else if partial > 0 && tok.len() >= 3 {
            // A seed word that's a meaningful prefix of an identifier word
            // (or vice versa) catches abbreviation in either direction:
            // "cust" said by the user matching "customer" in the schema,
            // or "customer" matching a column named "cust_id".
            let hit = seed_tokens
                .iter()
                .any(|st| st.len() >= 3 && (tok.starts_with(st.as_str()) || st.starts_with(tok.as_str())));
            if hit {
                score += partial;
            }
        }
    }
    score
}

/// Tables one foreign key hop from any pinned table, in either direction.
fn fk_adjacent_to<'a>(
    schema: &'a [SchemaNode],
    pinned: &HashSet<(&str, &str)>,
) -> HashSet<(&'a str, &'a str)> {
    let mut adjacent = HashSet::new();
    for s in schema {
        for t in &s.tables {
            let key = (s.name.as_str(), t.name.as_str());
            for c in &t.columns {
                for r in &c.references {
                    let target = (r.schema.as_str(), r.table.as_str());
                    if pinned.contains(&key) {
                        adjacent.insert(target);
                    }
                    if pinned.contains(&target) {
                        adjacent.insert(key);
                    }
                }
                for r in &c.referenced_by {
                    let source = (r.schema.as_str(), r.table.as_str());
                    if pinned.contains(&key) {
                        adjacent.insert(source);
                    }
                    if pinned.contains(&source) {
                        adjacent.insert(key);
                    }
                }
            }
        }
    }
    adjacent
}

/// Splits free text into lowercase words on anything that isn't a letter or
/// digit.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// Splits an identifier into lowercase words on `_`/`-`/whitespace and on
/// camelCase boundaries, so `cust_order_hdr` and `custOrderHdr` tokenize the
/// same way.
pub fn identifier_tokens(identifier: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for ch in identifier.chars() {
        if ch == '_' || ch == '-' || ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        if ch.is_uppercase() && prev_lower && !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
        prev_lower = ch.is_lowercase() || ch.is_numeric();
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn is_stopword(tok: &str) -> bool {
    tok.len() < 2 || STOPWORDS.contains(&tok)
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

    fn table(name: &str, columns: &[&str]) -> TableNode {
        TableNode {
            name: name.to_string(),
            kind: TableKind::Table,
            estimated_rows: None,
            columns: columns.iter().map(|c| column(c)).collect(),
        }
    }

    fn schema(name: &str, tables: Vec<TableNode>) -> SchemaNode {
        SchemaNode { name: name.to_string(), tables, functions: vec![], sequences: vec![], types: vec![] }
    }

    #[test]
    fn identifier_tokens_split_snake_and_camel_case() {
        assert_eq!(identifier_tokens("cust_order_hdr"), vec!["cust", "order", "hdr"]);
        assert_eq!(identifier_tokens("custOrderHdr"), vec!["cust", "order", "hdr"]);
    }

    #[test]
    fn selects_tables_matching_conversation_vocabulary() {
        let schemas = vec![schema(
            "public",
            vec![
                table("customer_orders", &["id", "customer_id", "total"]),
                table("shipping_labels", &["id", "carrier"]),
                table("audit_log", &["id", "actor"]),
            ],
        )];
        let pinned = HashSet::new();
        let selected =
            select_relevant_tables(&schemas, &pinned, "show me recent customer orders", 2);
        assert!(selected.contains(&("public", "customer_orders")));
    }

    #[test]
    fn fk_neighbor_of_pinned_table_outranks_unrelated_tables() {
        let mut orders = table("orders", &["id"]);
        let mut fk_col = column("customer_id");
        fk_col.references = vec![crate::db::ForeignKeyRef {
            schema: "public".to_string(),
            table: "customers".to_string(),
            column: "id".to_string(),
        }];
        orders.columns = vec![fk_col];
        let schemas = vec![schema(
            "public",
            vec![orders, table("customers", &["id"]), table("unrelated_widgets", &["id"])],
        )];
        let mut pinned = HashSet::new();
        pinned.insert(("public", "orders"));

        // Empty seed: only the FK bonus distinguishes tables.
        let selected = select_relevant_tables(&schemas, &pinned, "", 1);
        assert!(selected.contains(&("public", "customers")));
        assert!(!selected.contains(&("public", "unrelated_widgets")));
    }

    #[test]
    fn match_score_finds_multiword_query_a_literal_substring_search_would_miss() {
        // "customer orders" never appears as a literal substring of any
        // single identifier, so a pure `contains` search (the previous
        // implementation) always returned nothing for it.
        let tokens = tokenize("customer orders");
        assert!(match_score("cust_ord_hdr", "customer orders", &tokens).is_some());
    }

    #[test]
    fn match_score_prefers_exact_over_partial() {
        let tokens = tokenize("orders");
        let exact = match_score("orders", "orders", &tokens).unwrap();
        let partial = match_score("order_items", "orders", &tokens).unwrap();
        assert!(exact > partial);
    }
}
