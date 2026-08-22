//! Schema Compare — diff two schema snapshots and generate a best-effort
//! migration script.
//!
//! Pure, DB-free Rust: nothing here talks to Postgres. `postgres.rs` builds
//! a [`SchemaSnapshot`] from the live catalog (`PostgresSession::schema_snapshot`);
//! everything below just compares two of them and renders SQL text. Kept
//! separate so the diff and SQL-generation logic is fully unit-testable
//! without a live database.
//!
//! CubbyDB never runs the generated SQL itself — [`generate_migration_sql`]'s
//! output is always shown for the user to review, copy, and run with
//! whatever migration tool they already use.

use std::collections::HashMap;

use serde::Serialize;

use super::postgres::quote_ident;
use super::{CheckConstraintDetail, IndexDetail};

// --- Snapshot: what's actually in the database ----------------------------

/// One schema's ordinary base tables (`relkind = 'r'` — no views, matviews,
/// partitioned/foreign tables), with everything [`super::TableStructure`]
/// deliberately leaves out but a real DDL diff needs: named primary key,
/// named unique constraints, and named foreign keys with their `ON
/// UPDATE`/`ON DELETE` actions. Used only by Schema Compare.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub schema: String,
    pub tables: Vec<TableSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSnapshot {
    pub name: String,
    pub columns: Vec<ColumnSnapshot>,
    pub primary_key: Option<NamedKeySnapshot>,
    pub unique_constraints: Vec<NamedKeySnapshot>,
    pub foreign_keys: Vec<ForeignKeySnapshot>,
    pub indexes: Vec<IndexDetail>,
    pub check_constraints: Vec<CheckConstraintDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSnapshot {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_expr: Option<String>,
}

/// A named `PRIMARY KEY` or `UNIQUE` constraint and the columns it covers,
/// in key order (composite keys stay ordered).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedKeySnapshot {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeySnapshot {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: FkAction,
    pub on_delete: FkAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FkAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

impl FkAction {
    fn sql(self) -> &'static str {
        match self {
            FkAction::NoAction => "NO ACTION",
            FkAction::Restrict => "RESTRICT",
            FkAction::Cascade => "CASCADE",
            FkAction::SetNull => "SET NULL",
            FkAction::SetDefault => "SET DEFAULT",
        }
    }
}

/// Maps `pg_constraint.confupdtype`/`confdeltype`'s single-char codes.
/// Anything unrecognized falls back to `NoAction` rather than erroring —
/// this is metadata for a diff display/SQL generator, not enforcement.
pub fn fk_action_from_char(c: &str) -> FkAction {
    match c {
        "r" => FkAction::Restrict,
        "c" => FkAction::Cascade,
        "n" => FkAction::SetNull,
        "d" => FkAction::SetDefault,
        _ => FkAction::NoAction,
    }
}

// --- Diff: what's different between two snapshots --------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub before: Option<ColumnSnapshot>,
    pub after: Option<ColumnSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryKeyDiff {
    pub kind: ChangeKind,
    pub before: Option<NamedKeySnapshot>,
    pub after: Option<NamedKeySnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueConstraintDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub before: Option<NamedKeySnapshot>,
    pub after: Option<NamedKeySnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub before: Option<ForeignKeySnapshot>,
    pub after: Option<ForeignKeySnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub before: Option<IndexDetail>,
    pub after: Option<IndexDetail>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckConstraintDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub before: Option<CheckConstraintDetail>,
    pub after: Option<CheckConstraintDetail>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub name: String,
    pub kind: ChangeKind,
    pub columns: Vec<ColumnDiff>,
    pub primary_key: Option<PrimaryKeyDiff>,
    pub unique_constraints: Vec<UniqueConstraintDiff>,
    pub foreign_keys: Vec<ForeignKeyDiff>,
    pub indexes: Vec<IndexDiff>,
    pub check_constraints: Vec<CheckConstraintDiff>,
}

/// Only tables with at least one change — two identical schemas produce an
/// empty `tables` list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    pub tables: Vec<TableDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationScript {
    pub sql: String,
    pub statement_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCompareResult {
    pub diff: SchemaDiff,
    pub migration: MigrationScript,
}

// --- Diffing -----------------------------------------------------------

/// Diffs `source` against `target`. The result is directional: `Added` means
/// "in target but not source", `Removed` means "in source but not target" —
/// [`generate_migration_sql`] turns that into SQL that transforms source
/// into target.
pub fn diff_snapshots(source: &SchemaSnapshot, target: &SchemaSnapshot) -> SchemaDiff {
    let source_by_name: HashMap<&str, &TableSnapshot> =
        source.tables.iter().map(|t| (t.name.as_str(), t)).collect();
    let target_by_name: HashMap<&str, &TableSnapshot> =
        target.tables.iter().map(|t| (t.name.as_str(), t)).collect();

    let mut names: Vec<&str> = source_by_name.keys().chain(target_by_name.keys()).copied().collect();
    names.sort_unstable();
    names.dedup();

    let mut tables = Vec::new();
    for name in names {
        match (source_by_name.get(name), target_by_name.get(name)) {
            (None, Some(t)) => tables.push(table_diff_whole(t, ChangeKind::Added)),
            (Some(s), None) => tables.push(table_diff_whole(s, ChangeKind::Removed)),
            (Some(s), Some(t)) => {
                if let Some(d) = diff_table(s, t, &source.schema, &target.schema) {
                    tables.push(d);
                }
            }
            (None, None) => unreachable!("name came from one of the two maps"),
        }
    }

    SchemaDiff { tables }
}

/// A whole table that exists on only one side — every column/constraint/
/// index is reported as wholly Added or wholly Removed, for display.
fn table_diff_whole(table: &TableSnapshot, kind: ChangeKind) -> TableDiff {
    let is_added = kind == ChangeKind::Added;

    let columns = table
        .columns
        .iter()
        .map(|c| ColumnDiff {
            name: c.name.clone(),
            kind,
            before: (!is_added).then(|| c.clone()),
            after: is_added.then(|| c.clone()),
        })
        .collect();
    let primary_key = table.primary_key.as_ref().map(|pk| PrimaryKeyDiff {
        kind,
        before: (!is_added).then(|| pk.clone()),
        after: is_added.then(|| pk.clone()),
    });
    let unique_constraints = table
        .unique_constraints
        .iter()
        .map(|k| UniqueConstraintDiff {
            name: k.name.clone(),
            kind,
            before: (!is_added).then(|| k.clone()),
            after: is_added.then(|| k.clone()),
        })
        .collect();
    let foreign_keys = table
        .foreign_keys
        .iter()
        .map(|fk| ForeignKeyDiff {
            name: fk.name.clone(),
            kind,
            before: (!is_added).then(|| fk.clone()),
            after: is_added.then(|| fk.clone()),
        })
        .collect();
    let indexes = table
        .indexes
        .iter()
        .map(|i| IndexDiff {
            name: i.name.clone(),
            kind,
            before: (!is_added).then(|| i.clone()),
            after: is_added.then(|| i.clone()),
        })
        .collect();
    let check_constraints = table
        .check_constraints
        .iter()
        .map(|c| CheckConstraintDiff {
            name: c.name.clone(),
            kind,
            before: (!is_added).then(|| c.clone()),
            after: is_added.then(|| c.clone()),
        })
        .collect();

    TableDiff {
        name: table.name.clone(),
        kind,
        columns,
        primary_key,
        unique_constraints,
        foreign_keys,
        indexes,
        check_constraints,
    }
}

/// A table present on both sides — diffs each category independently.
/// Returns `None` if every category is empty (the table is identical).
fn diff_table(
    s: &TableSnapshot,
    t: &TableSnapshot,
    source_schema: &str,
    target_schema: &str,
) -> Option<TableDiff> {
    let columns = diff_by_name(&s.columns, &t.columns, |c| c.name.as_str(), |a, b| a == b, |name, kind, before, after| {
        ColumnDiff { name: name.to_string(), kind, before, after }
    });
    let primary_key = diff_primary_key(s.primary_key.as_ref(), t.primary_key.as_ref());
    let unique_constraints = diff_by_name(
        &s.unique_constraints,
        &t.unique_constraints,
        |k| k.name.as_str(),
        |a, b| a == b,
        |name, kind, before, after| UniqueConstraintDiff { name: name.to_string(), kind, before, after },
    );
    let foreign_keys = diff_by_name(
        &s.foreign_keys,
        &t.foreign_keys,
        |k| k.name.as_str(),
        |a, b| a == b,
        |name, kind, before, after| ForeignKeyDiff { name: name.to_string(), kind, before, after },
    );
    let indexes = diff_by_name(
        &s.indexes,
        &t.indexes,
        |i| i.name.as_str(),
        // Best-effort: `pg_indexes.indexdef` is always schema-qualified, so
        // two otherwise-identical indexes would look "changed" purely
        // because source/target live in differently-named schemas. Strip
        // that qualifier before comparing.
        |a, b| normalize_schema_qualifier(&a.definition, source_schema) == normalize_schema_qualifier(&b.definition, target_schema),
        |name, kind, before, after| IndexDiff { name: name.to_string(), kind, before, after },
    );
    let check_constraints = diff_by_name(
        &s.check_constraints,
        &t.check_constraints,
        |c| c.name.as_str(),
        // `CHECK (...)` text from `pg_get_constraintdef` is schema-agnostic
        // already — no qualifier to normalize.
        |a, b| a.definition == b.definition,
        |name, kind, before, after| CheckConstraintDiff { name: name.to_string(), kind, before, after },
    );

    let empty = columns.is_empty()
        && primary_key.is_none()
        && unique_constraints.is_empty()
        && foreign_keys.is_empty()
        && indexes.is_empty()
        && check_constraints.is_empty();
    if empty {
        return None;
    }

    Some(TableDiff {
        name: s.name.clone(),
        kind: ChangeKind::Changed,
        columns,
        primary_key,
        unique_constraints,
        foreign_keys,
        indexes,
        check_constraints,
    })
}

/// Diffs two named-item lists, matched by **name** — the only sane join key
/// for constraints/indexes; matching by column set instead would silently
/// merge two unrelated items that happen to cover the same columns.
fn diff_by_name<T: Clone, D>(
    source: &[T],
    target: &[T],
    name_of: impl Fn(&T) -> &str,
    same: impl Fn(&T, &T) -> bool,
    make: impl Fn(&str, ChangeKind, Option<T>, Option<T>) -> D,
) -> Vec<D> {
    let source_by_name: HashMap<&str, &T> = source.iter().map(|x| (name_of(x), x)).collect();
    let target_by_name: HashMap<&str, &T> = target.iter().map(|x| (name_of(x), x)).collect();

    let mut names: Vec<&str> = source_by_name.keys().chain(target_by_name.keys()).copied().collect();
    names.sort_unstable();
    names.dedup();

    let mut out = Vec::new();
    for name in names {
        match (source_by_name.get(name), target_by_name.get(name)) {
            (None, Some(t)) => out.push(make(name, ChangeKind::Added, None, Some((*t).clone()))),
            (Some(s), None) => out.push(make(name, ChangeKind::Removed, Some((*s).clone()), None)),
            (Some(s), Some(t)) => {
                if !same(s, t) {
                    out.push(make(name, ChangeKind::Changed, Some((*s).clone()), Some((*t).clone())));
                }
            }
            (None, None) => unreachable!("name came from one of the two maps"),
        }
    }
    out
}

fn diff_primary_key(
    source: Option<&NamedKeySnapshot>,
    target: Option<&NamedKeySnapshot>,
) -> Option<PrimaryKeyDiff> {
    match (source, target) {
        (None, None) => None,
        (None, Some(t)) => Some(PrimaryKeyDiff { kind: ChangeKind::Added, before: None, after: Some(t.clone()) }),
        (Some(s), None) => Some(PrimaryKeyDiff { kind: ChangeKind::Removed, before: Some(s.clone()), after: None }),
        (Some(s), Some(t)) => {
            if s == t {
                None
            } else {
                Some(PrimaryKeyDiff {
                    kind: ChangeKind::Changed,
                    before: Some(s.clone()),
                    after: Some(t.clone()),
                })
            }
        }
    }
}

fn normalize_schema_qualifier(def: &str, schema: &str) -> String {
    def.replace(&format!("ON {}.", quote_ident(schema)), "ON <schema>.")
        .replace(&format!("ON {}.", schema), "ON <schema>.")
}

// --- SQL generation ----------------------------------------------------

/// Renders `diff` as a best-effort migration script that transforms
/// `source_schema` into what `target_schema` looks like. Statement order:
/// `CREATE TABLE` (columns only) -> `ALTER COLUMN` -> primary key ->
/// unique constraints -> indexes -> foreign keys -> check constraints ->
/// `DROP TABLE`, last. Tables being dropped are skipped in every earlier
/// pass — dropping the table already removes everything on it.
///
/// This ordering is best-effort, not a guaranteed-valid general schema
/// differ: circular foreign keys or objects outside this schema can still
/// need manual reordering, which the generated header comment says
/// explicitly. CubbyDB never executes this script itself.
pub fn generate_migration_sql(source_schema: &str, target_schema: &str, diff: &SchemaDiff) -> MigrationScript {
    let mut statements: Vec<String> = Vec::new();

    for table in diff.tables.iter().filter(|t| t.kind == ChangeKind::Added) {
        statements.push(create_table_sql(source_schema, table));
    }

    for table in diff.tables.iter().filter(|t| t.kind == ChangeKind::Changed) {
        for col in &table.columns {
            statements.extend(alter_column_sql(source_schema, &table.name, col));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind != ChangeKind::Removed) {
        if let Some(pk) = &table.primary_key {
            statements.extend(alter_key_sql(source_schema, &table.name, pk.before.as_ref(), pk.after.as_ref(), "PRIMARY KEY"));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind != ChangeKind::Removed) {
        for uq in &table.unique_constraints {
            statements.extend(alter_key_sql(source_schema, &table.name, uq.before.as_ref(), uq.after.as_ref(), "UNIQUE"));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind != ChangeKind::Removed) {
        for idx in &table.indexes {
            statements.extend(alter_index_sql(source_schema, target_schema, idx));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind != ChangeKind::Removed) {
        for fk in &table.foreign_keys {
            statements.extend(alter_fk_sql(source_schema, &table.name, fk));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind != ChangeKind::Removed) {
        for chk in &table.check_constraints {
            statements.extend(alter_check_sql(source_schema, &table.name, chk));
        }
    }

    for table in diff.tables.iter().filter(|t| t.kind == ChangeKind::Removed) {
        statements.push(format!(
            "-- WARNING: review dependent objects before running this DROP\nDROP TABLE {}.{};",
            quote_ident(source_schema),
            quote_ident(&table.name)
        ));
    }

    let mut sql = String::from(
        "-- Generated by CubbyDB Schema Compare. Review carefully before running.\n\
-- This statement ordering is best-effort: complex cases (circular foreign\n\
-- keys, dependent objects outside this schema) may need manual reordering.\n\
-- CubbyDB will never run this for you.",
    );
    for s in &statements {
        sql.push_str("\n\n");
        sql.push_str(s);
    }

    MigrationScript { statement_count: statements.len(), sql }
}

fn column_def_sql(col: &ColumnSnapshot) -> String {
    let mut s = format!("{} {}", quote_ident(&col.name), col.data_type);
    if !col.nullable {
        s.push_str(" NOT NULL");
    }
    if let Some(default) = &col.default_expr {
        s.push_str(" DEFAULT ");
        s.push_str(default);
    }
    s
}

fn create_table_sql(schema: &str, table: &TableDiff) -> String {
    let cols: Vec<String> = table.columns.iter().filter_map(|c| c.after.as_ref()).map(column_def_sql).collect();
    format!(
        "CREATE TABLE {}.{} (\n    {}\n);",
        quote_ident(schema),
        quote_ident(&table.name),
        cols.join(",\n    ")
    )
}

fn alter_column_sql(schema: &str, table: &str, col: &ColumnDiff) -> Vec<String> {
    let qtable = format!("{}.{}", quote_ident(schema), quote_ident(table));
    match (&col.before, &col.after) {
        (None, Some(after)) => {
            let stmt = format!("ALTER TABLE {} ADD COLUMN {};", qtable, column_def_sql(after));
            if !after.nullable && after.default_expr.is_none() {
                vec![format!(
                    "-- WARNING: adding a NOT NULL column with no default will fail if the table already has rows\n{}",
                    stmt
                )]
            } else {
                vec![stmt]
            }
        }
        (Some(_), None) => vec![format!("ALTER TABLE {} DROP COLUMN {};", qtable, quote_ident(&col.name))],
        (Some(before), Some(after)) => {
            let mut out = Vec::new();
            if before.data_type != after.data_type {
                out.push(format!(
                    "-- WARNING: no USING clause — Postgres will reject this if the types aren't automatically castable\nALTER TABLE {} ALTER COLUMN {} TYPE {};",
                    qtable,
                    quote_ident(&col.name),
                    after.data_type
                ));
            }
            if before.nullable != after.nullable {
                let clause = if after.nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                out.push(format!("ALTER TABLE {} ALTER COLUMN {} {};", qtable, quote_ident(&col.name), clause));
            }
            if before.default_expr != after.default_expr {
                match &after.default_expr {
                    Some(expr) => out.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {};",
                        qtable,
                        quote_ident(&col.name),
                        expr
                    )),
                    None => out.push(format!("ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT;", qtable, quote_ident(&col.name))),
                }
            }
            out
        }
        (None, None) => vec![],
    }
}

/// Shared DROP-then-ADD shape for `PRIMARY KEY`/`UNIQUE` constraints —
/// `key_kind_sql` is the literal `"PRIMARY KEY"` or `"UNIQUE"` keyword.
fn alter_key_sql(
    schema: &str,
    table: &str,
    before: Option<&NamedKeySnapshot>,
    after: Option<&NamedKeySnapshot>,
    key_kind_sql: &str,
) -> Vec<String> {
    let qtable = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let mut out = Vec::new();
    if let Some(b) = before {
        out.push(format!("ALTER TABLE {} DROP CONSTRAINT {};", qtable, quote_ident(&b.name)));
    }
    if let Some(a) = after {
        let cols = a.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        out.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} {} ({});",
            qtable,
            quote_ident(&a.name),
            key_kind_sql,
            cols
        ));
    }
    out
}

fn alter_fk_sql(schema: &str, table: &str, fk: &ForeignKeyDiff) -> Vec<String> {
    let qtable = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let mut out = Vec::new();
    if let Some(before) = &fk.before {
        out.push(format!("ALTER TABLE {} DROP CONSTRAINT {};", qtable, quote_ident(&before.name)));
    }
    if let Some(after) = &fk.after {
        let cols = after.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        let ref_cols = after.ref_columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        out.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON UPDATE {} ON DELETE {};",
            qtable,
            quote_ident(&after.name),
            cols,
            quote_ident(&after.ref_schema),
            quote_ident(&after.ref_table),
            ref_cols,
            after.on_update.sql(),
            after.on_delete.sql()
        ));
    }
    out
}

fn alter_check_sql(schema: &str, table: &str, chk: &CheckConstraintDiff) -> Vec<String> {
    let qtable = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let mut out = Vec::new();
    if let Some(before) = &chk.before {
        out.push(format!("ALTER TABLE {} DROP CONSTRAINT {};", qtable, quote_ident(&before.name)));
    }
    if let Some(after) = &chk.after {
        // `after.definition` is already `CHECK (...)` text from
        // `pg_get_constraintdef` — schema-agnostic, no rewrite needed.
        out.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} {};",
            qtable,
            quote_ident(&after.name),
            after.definition
        ));
    }
    out
}

fn alter_index_sql(source_schema: &str, target_schema: &str, idx: &IndexDiff) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(before) = &idx.before {
        out.push(format!("DROP INDEX {}.{};", quote_ident(source_schema), quote_ident(&before.name)));
    }
    if let Some(after) = &idx.after {
        out.push(format!("{};", rewrite_index_schema(&after.definition, target_schema, source_schema)));
    }
    out
}

/// `pg_indexes.indexdef` always renders fully schema-qualified (`ON
/// schema.table`). When reusing a *target* index's definition to create it
/// on the *source* schema, the qualifier has to move with it or the index
/// would be created in the wrong place. This is a targeted text
/// substitution, not a SQL parser — best-effort, like the rest of this
/// generator.
fn rewrite_index_schema(def: &str, from_schema: &str, to_schema: &str) -> String {
    def.replace(&format!("ON {}.", quote_ident(from_schema)), &format!("ON {}.", quote_ident(to_schema)))
        .replace(&format!("ON {}.", from_schema), &format!("ON {}.", to_schema))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str, nullable: bool, default_expr: Option<&str>) -> ColumnSnapshot {
        ColumnSnapshot {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable,
            default_expr: default_expr.map(|s| s.to_string()),
        }
    }

    fn key(name: &str, columns: &[&str]) -> NamedKeySnapshot {
        NamedKeySnapshot {
            name: name.to_string(),
            columns: columns.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn empty_table(name: &str) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: vec![],
            primary_key: None,
            unique_constraints: vec![],
            foreign_keys: vec![],
            indexes: vec![],
            check_constraints: vec![],
        }
    }

    fn snapshot(schema: &str, tables: Vec<TableSnapshot>) -> SchemaSnapshot {
        SchemaSnapshot { schema: schema.to_string(), tables }
    }

    #[test]
    fn identical_snapshots_produce_empty_diff() {
        let mut t = empty_table("users");
        t.columns.push(col("id", "int8", false, None));
        let source = snapshot("public", vec![t.clone()]);
        let target = snapshot("public", vec![t]);
        let diff = diff_snapshots(&source, &target);
        assert!(diff.tables.is_empty());
    }

    #[test]
    fn added_table_generates_create_then_deferred_constraints() {
        let mut t = empty_table("orders");
        t.columns.push(col("id", "int8", false, None));
        t.primary_key = Some(key("orders_pkey", &["id"]));
        t.foreign_keys.push(ForeignKeySnapshot {
            name: "orders_user_id_fkey".to_string(),
            columns: vec!["user_id".to_string()],
            ref_schema: "public".to_string(),
            ref_table: "users".to_string(),
            ref_columns: vec!["id".to_string()],
            on_update: FkAction::NoAction,
            on_delete: FkAction::Cascade,
        });

        let source = snapshot("public", vec![]);
        let target = snapshot("public", vec![t]);
        let diff = diff_snapshots(&source, &target);
        let migration = generate_migration_sql("public", "public", &diff);

        let create_idx = migration.sql.find("CREATE TABLE").expect("has CREATE TABLE");
        let pk_idx = migration.sql.find("PRIMARY KEY").expect("has PRIMARY KEY");
        let fk_idx = migration.sql.find("FOREIGN KEY").expect("has FOREIGN KEY");
        assert!(create_idx < pk_idx, "CREATE TABLE must come before PRIMARY KEY");
        assert!(pk_idx < fk_idx, "PRIMARY KEY must come before FOREIGN KEY");

        let create_stmt = &migration.sql[create_idx..pk_idx];
        assert!(!create_stmt.contains("PRIMARY KEY"), "CREATE TABLE must not inline the PK");
        assert!(!create_stmt.contains("REFERENCES"), "CREATE TABLE must not inline the FK");
    }

    #[test]
    fn removed_table_generates_single_drop_no_orphan_constraint_drops() {
        let mut t = empty_table("legacy");
        t.columns.push(col("id", "int8", false, None));
        t.primary_key = Some(key("legacy_pkey", &["id"]));
        t.indexes.push(IndexDetail { name: "legacy_idx".to_string(), definition: "CREATE INDEX legacy_idx ON public.legacy USING btree (id)".to_string() });

        let source = snapshot("public", vec![t]);
        let target = snapshot("public", vec![]);
        let diff = diff_snapshots(&source, &target);
        let migration = generate_migration_sql("public", "public", &diff);

        assert_eq!(migration.sql.matches("DROP TABLE").count(), 1);
        assert!(!migration.sql.contains("DROP CONSTRAINT"));
        assert!(!migration.sql.contains("DROP INDEX"));
    }

    #[test]
    fn column_type_change_emits_alter_column_type_with_warning_comment() {
        let mut before = empty_table("t");
        before.columns.push(col("amount", "integer", false, None));
        let mut after = before.clone();
        after.columns[0].data_type = "bigint".to_string();

        let source = snapshot("public", vec![before]);
        let target = snapshot("public", vec![after]);
        let diff = diff_snapshots(&source, &target);
        let migration = generate_migration_sql("public", "public", &diff);

        assert!(migration.sql.contains("-- WARNING: no USING clause"));
        assert!(migration.sql.contains(r#"ALTER TABLE "public"."t" ALTER COLUMN "amount" TYPE bigint;"#));
    }

    #[test]
    fn column_becomes_not_null_without_default_emits_warning_comment() {
        let mut before = empty_table("t");
        before.columns.push(col("amount", "integer", false, None));
        let source = snapshot("public", vec![before]);

        let mut t = empty_table("t");
        t.columns.push(col("note", "text", false, None));
        let target = snapshot("public", vec![t]);

        let diff = diff_snapshots(&source, &target);
        let migration = generate_migration_sql("public", "public", &diff);

        assert!(migration.sql.contains("-- WARNING: adding a NOT NULL column with no default"));
        assert!(migration.sql.contains(r#"ADD COLUMN "note" text NOT NULL;"#));
    }

    #[test]
    fn column_default_added_and_removed() {
        let mut a = empty_table("t");
        a.columns.push(col("status", "text", true, None));
        let mut b = a.clone();
        b.columns[0].default_expr = Some("'pending'::text".to_string());

        let diff = diff_snapshots(&snapshot("public", vec![a.clone()]), &snapshot("public", vec![b.clone()]));
        let migration = generate_migration_sql("public", "public", &diff);
        assert!(migration.sql.contains(r#"ALTER TABLE "public"."t" ALTER COLUMN "status" SET DEFAULT 'pending'::text;"#));

        let diff_back = diff_snapshots(&snapshot("public", vec![b]), &snapshot("public", vec![a]));
        let migration_back = generate_migration_sql("public", "public", &diff_back);
        assert!(migration_back.sql.contains(r#"ALTER TABLE "public"."t" ALTER COLUMN "status" DROP DEFAULT;"#));
    }

    #[test]
    fn primary_key_changed_emits_drop_then_add() {
        let mut before = empty_table("t");
        before.columns.push(col("id", "int8", false, None));
        before.primary_key = Some(key("t_pkey_old", &["id"]));
        let mut after = before.clone();
        after.primary_key = Some(key("t_pkey_new", &["id"]));

        let diff = diff_snapshots(&snapshot("public", vec![before]), &snapshot("public", vec![after]));
        let migration = generate_migration_sql("public", "public", &diff);

        let drop_idx = migration.sql.find(r#"DROP CONSTRAINT "t_pkey_old""#).expect("drops old PK");
        let add_idx = migration.sql.find(r#"ADD CONSTRAINT "t_pkey_new" PRIMARY KEY ("id")"#).expect("adds new PK");
        assert!(drop_idx < add_idx);
    }

    #[test]
    fn unique_constraint_added_and_removed_matched_by_name() {
        let mut before = empty_table("t");
        before.columns.push(col("email", "text", true, None));
        before.unique_constraints.push(key("t_email_old_key", &["email"]));

        let mut after = empty_table("t");
        after.columns.push(col("email", "text", true, None));
        after.unique_constraints.push(key("t_email_new_key", &["email"]));

        let diff = diff_snapshots(&snapshot("public", vec![before]), &snapshot("public", vec![after]));
        let migration = generate_migration_sql("public", "public", &diff);

        assert!(migration.sql.contains(r#"DROP CONSTRAINT "t_email_old_key""#));
        assert!(migration.sql.contains(r#"ADD CONSTRAINT "t_email_new_key" UNIQUE ("email")"#));
    }

    fn fk(name: &str, on_delete: FkAction) -> ForeignKeySnapshot {
        ForeignKeySnapshot {
            name: name.to_string(),
            columns: vec!["user_id".to_string()],
            ref_schema: "public".to_string(),
            ref_table: "users".to_string(),
            ref_columns: vec!["id".to_string()],
            on_update: FkAction::NoAction,
            on_delete,
        }
    }

    #[test]
    fn foreign_key_action_change_emits_drop_then_add() {
        let mut before = empty_table("orders");
        before.foreign_keys.push(fk("orders_user_id_fkey", FkAction::NoAction));
        let mut after = empty_table("orders");
        after.foreign_keys.push(fk("orders_user_id_fkey", FkAction::Cascade));

        let diff = diff_snapshots(&snapshot("public", vec![before]), &snapshot("public", vec![after]));
        assert_eq!(diff.tables.len(), 1);
        assert_eq!(diff.tables[0].foreign_keys.len(), 1);
        assert_eq!(diff.tables[0].foreign_keys[0].kind, ChangeKind::Changed);

        let migration = generate_migration_sql("public", "public", &diff);
        let drop_idx = migration.sql.find(r#"DROP CONSTRAINT "orders_user_id_fkey""#).unwrap();
        let add_idx = migration.sql.find("ADD CONSTRAINT \"orders_user_id_fkey\" FOREIGN KEY").unwrap();
        assert!(drop_idx < add_idx);
    }

    #[test]
    fn foreign_key_actions_render_explicitly() {
        let mut t = empty_table("orders");
        t.foreign_keys.push(fk("orders_user_id_fkey", FkAction::NoAction));
        let diff = diff_snapshots(&snapshot("public", vec![]), &snapshot("public", vec![t]));
        let migration = generate_migration_sql("public", "public", &diff);
        assert!(migration.sql.contains("ON UPDATE NO ACTION ON DELETE NO ACTION;"));
    }

    #[test]
    fn check_constraint_added_and_removed() {
        let before = empty_table("t");
        let mut after = empty_table("t");
        after.check_constraints.push(CheckConstraintDetail {
            name: "t_amount_check".to_string(),
            definition: "CHECK (amount > 0)".to_string(),
        });

        let diff = diff_snapshots(&snapshot("public", vec![before.clone()]), &snapshot("public", vec![after.clone()]));
        let migration = generate_migration_sql("public", "public", &diff);
        assert!(migration.sql.contains(r#"ADD CONSTRAINT "t_amount_check" CHECK (amount > 0);"#));

        let diff_back = diff_snapshots(&snapshot("public", vec![after]), &snapshot("public", vec![before]));
        let migration_back = generate_migration_sql("public", "public", &diff_back);
        assert!(migration_back.sql.contains(r#"DROP CONSTRAINT "t_amount_check""#));
    }

    #[test]
    fn index_create_reuses_target_definition_text_verbatim_when_schema_names_match() {
        let before = empty_table("t");
        let mut after = empty_table("t");
        after.indexes.push(IndexDetail {
            name: "t_email_idx".to_string(),
            definition: "CREATE INDEX t_email_idx ON public.t USING btree (email)".to_string(),
        });

        let diff = diff_snapshots(&snapshot("public", vec![before]), &snapshot("public", vec![after]));
        let migration = generate_migration_sql("public", "public", &diff);
        assert!(migration.sql.contains("CREATE INDEX t_email_idx ON public.t USING btree (email);"));
    }

    #[test]
    fn index_create_rewrites_schema_qualifier_when_source_and_target_schema_names_differ() {
        let before = empty_table("orders");
        let mut after = empty_table("orders");
        after.indexes.push(IndexDetail {
            name: "orders_created_idx".to_string(),
            definition: "CREATE INDEX orders_created_idx ON staging.orders USING btree (created_at)".to_string(),
        });

        let diff = diff_snapshots(&snapshot("public", vec![before]), &snapshot("staging", vec![after]));
        let migration = generate_migration_sql("public", "staging", &diff);

        assert!(migration.sql.contains("ON public.orders"), "sql was: {}", migration.sql);
        assert!(!migration.sql.contains("ON staging.orders"));
    }

    #[test]
    fn full_ordering_smoke_test() {
        let mut before = empty_table("orders");
        before.columns.push(col("id", "int8", false, None));
        before.columns.push(col("total", "integer", false, None));
        before.primary_key = Some(key("orders_pkey", &["id"]));
        before.unique_constraints.push(key("orders_ref_key", &["total"]));
        before.foreign_keys.push(fk("orders_user_id_fkey", FkAction::NoAction));
        before.indexes.push(IndexDetail { name: "orders_total_idx".to_string(), definition: "CREATE INDEX orders_total_idx ON public.orders USING btree (total)".to_string() });
        before.check_constraints.push(CheckConstraintDetail { name: "orders_total_check".to_string(), definition: "CHECK (total >= 0)".to_string() });

        let mut after = before.clone();
        after.columns[1].data_type = "bigint".to_string();

        let mut removed = empty_table("legacy");
        removed.columns.push(col("id", "int8", false, None));

        let mut added = empty_table("shipments");
        added.columns.push(col("id", "int8", false, None));

        let source = snapshot("public", vec![before, removed]);
        let target = snapshot("public", vec![after, added]);
        let diff = diff_snapshots(&source, &target);
        let migration = generate_migration_sql("public", "public", &diff);

        let create_pos = migration.sql.find("CREATE TABLE \"public\".\"shipments\"").unwrap();
        let alter_pos = migration.sql.find("ALTER COLUMN \"total\" TYPE bigint").unwrap();
        let drop_table_pos = migration.sql.find("DROP TABLE \"public\".\"legacy\"").unwrap();

        assert!(create_pos < alter_pos, "CREATE TABLE (new table) should come before ALTER COLUMN (changed table)");
        assert!(alter_pos < drop_table_pos, "ALTER COLUMN should come well before the final DROP TABLE pass");
    }
}
