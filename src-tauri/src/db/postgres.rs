//! PostgreSQL implementation of the [`DatabaseDriver`] / [`DbSession`] traits.
//!
//! This is the only module that depends on `tokio-postgres`. Result values are
//! read with `simple_query`, which returns every value in its canonical text
//! representation, so we never need per-type conversion code in the grid path.

use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use async_trait::async_trait;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::{Client, Config, SimpleQueryMessage};

use super::{
    CheckConstraintDetail, ColumnNode, ColumnValue, ConnectionInfo, ConnectionParams,
    DatabaseDriver, DbError, DbErrorKind, DbSession, DeleteImpact, DependentRowsPreview, Engine,
    ForeignKeyRef, FunctionDefinition, FunctionKind, FunctionNode, IndexDetail, QueryCanceller,
    QueryResult, ResultColumn, SchemaNode, SequenceDetails, SequenceNode, SequenceOwner,
    StructureColumn, TableKind, TableNode, TableStructure, TypeNode,
};

/// Stateless factory for Postgres sessions.
pub struct PostgresDriver;

impl PostgresDriver {
    pub fn new() -> Self {
        PostgresDriver
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    async fn test_connection(&self, params: &ConnectionParams) -> Result<ConnectionInfo, DbError> {
        // Establish and immediately drop; we only want the version + timing.
        let (_client, info) = establish(params).await?;
        Ok(info)
    }

    async fn connect(&self, params: &ConnectionParams) -> Result<Box<dyn DbSession>, DbError> {
        let (client, info) = establish(params).await?;
        Ok(Box::new(PostgresSession { client, info }))
    }
}

/// A live Postgres connection.
struct PostgresSession {
    client: tokio_postgres::Client,
    info: ConnectionInfo,
}

#[async_trait]
impl DbSession for PostgresSession {
    fn info(&self) -> &ConnectionInfo {
        &self.info
    }

    async fn fetch_schema(&self) -> Result<Vec<SchemaNode>, DbError> {
        // 1) All user schemas (so empty schemas still show in the tree).
        let schema_rows = self
            .client
            .query(SCHEMA_LIST_SQL, &[])
            .await
            .map_err(map_query_err)?;

        // 2) Every column of every table/view, with type, nullability, PK flag,
        //    and the planner's estimated row count. Ordered so we can fold it
        //    into the tree in a single pass.
        let col_rows = self
            .client
            .query(SCHEMA_COLUMNS_SQL, &[])
            .await
            .map_err(map_query_err)?;

        // 3) Foreign keys, keyed by (schema, table, column).
        let fk_rows = self
            .client
            .query(FOREIGN_KEYS_SQL, &[])
            .await
            .map_err(map_query_err)?;
        // Outgoing: keyed by referencing column -> the column it points at.
        let mut fk_map: HashMap<(String, String, String), Vec<ForeignKeyRef>> = HashMap::new();
        // Incoming: keyed by referenced column -> the columns pointing at it.
        let mut rev_fk_map: HashMap<(String, String, String), Vec<ForeignKeyRef>> = HashMap::new();
        for row in &fk_rows {
            let (schema, table, column): (String, String, String) =
                (row.get(0), row.get(1), row.get(2));
            let (ref_schema, ref_table, ref_column): (String, String, String) =
                (row.get(3), row.get(4), row.get(5));

            fk_map
                .entry((schema.clone(), table.clone(), column.clone()))
                .or_default()
                .push(ForeignKeyRef {
                    schema: ref_schema.clone(),
                    table: ref_table.clone(),
                    column: ref_column.clone(),
                });
            rev_fk_map
                .entry((ref_schema, ref_table, ref_column))
                .or_default()
                .push(ForeignKeyRef {
                    schema,
                    table,
                    column,
                });
        }

        // 4-6) Functions/procedures, sequences, and enum types — each a
        //    single whole-schema query, folded in below alongside the
        //    columns fold. Functions/sequences are listed lightly here (name
        //    + signature); their bodies/current-value are fetched lazily,
        //    only when opened (see `function_definition`/`sequence_details`).
        let function_rows = self
            .client
            .query(FUNCTIONS_SQL, &[])
            .await
            .map_err(map_query_err)?;
        let sequence_rows = self
            .client
            .query(SEQUENCES_SQL, &[])
            .await
            .map_err(map_query_err)?;
        let type_rows = self
            .client
            .query(ENUM_TYPES_SQL, &[])
            .await
            .map_err(map_query_err)?;

        // Fold columns into an ordered map: schema -> tables -> columns.
        let mut schemas: Vec<SchemaNode> = schema_rows
            .iter()
            .map(|r| SchemaNode {
                name: r.get::<_, String>(0),
                tables: Vec::new(),
                functions: Vec::new(),
                sequences: Vec::new(),
                types: Vec::new(),
            })
            .collect();

        for row in &col_rows {
            let schema_name: String = row.get(0);
            let table_name: String = row.get(1);
            let relkind: String = row.get(2);
            let column: String = row.get(3);
            let data_type: String = row.get(4);
            let nullable: bool = row.get(5);
            let is_primary_key: bool = row.get(6);
            let estimated_rows: Option<i64> = row.get(7);

            let key = (schema_name.clone(), table_name.clone(), column.clone());
            let references = fk_map.get(&key).cloned().unwrap_or_default();
            let referenced_by = rev_fk_map.get(&key).cloned().unwrap_or_default();

            let Some(schema) = schemas.iter_mut().find(|s| s.name == schema_name) else {
                continue;
            };

            let kind = match relkind.as_str() {
                "v" | "m" => TableKind::View,
                _ => TableKind::Table,
            };

            let table = match schema.tables.iter_mut().find(|t| t.name == table_name) {
                Some(existing) => existing,
                None => {
                    schema.tables.push(TableNode {
                        name: table_name,
                        kind,
                        estimated_rows,
                        columns: Vec::new(),
                    });
                    schema.tables.last_mut().expect("just pushed")
                }
            };

            table.columns.push(ColumnNode {
                name: column,
                data_type,
                nullable,
                is_primary_key,
                references,
                referenced_by,
            });
        }

        for row in &function_rows {
            let schema_name: String = row.get(0);
            let Some(schema) = schemas.iter_mut().find(|s| s.name == schema_name) else {
                continue;
            };
            let prokind: String = row.get(5);
            schema.functions.push(FunctionNode {
                oid: row.get(1),
                name: row.get(2),
                arguments: row.get(3),
                return_type: row.get(4),
                kind: if prokind == "p" {
                    FunctionKind::Procedure
                } else {
                    FunctionKind::Function
                },
            });
        }

        for row in &sequence_rows {
            let schema_name: String = row.get(0);
            let Some(schema) = schemas.iter_mut().find(|s| s.name == schema_name) else {
                continue;
            };
            let owner_table: Option<String> = row.get(2);
            let owner_column: Option<String> = row.get(3);
            let owned_by = match (owner_table, owner_column) {
                (Some(table), Some(column)) => Some(SequenceOwner { table, column }),
                _ => None,
            };
            schema.sequences.push(SequenceNode {
                name: row.get(1),
                owned_by,
            });
        }

        for row in &type_rows {
            let schema_name: String = row.get(0);
            let Some(schema) = schemas.iter_mut().find(|s| s.name == schema_name) else {
                continue;
            };
            schema.types.push(TypeNode {
                name: row.get(1),
                values: row.get(2),
            });
        }

        Ok(schemas)
    }

    async fn run_query(&self, sql: &str) -> Result<QueryResult, DbError> {
        let (final_sql, limit_applied) = apply_default_limit(sql, super::DEFAULT_ROW_LIMIT);

        let start = Instant::now();
        let messages = self
            .client
            .simple_query(&final_sql)
            .await
            .map_err(map_query_err)?;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(simple_query_messages_to_result(sql, messages, elapsed_ms, limit_applied))
    }

    async fn run_read_only_query(&self, sql: &str) -> Result<QueryResult, DbError> {
        let (final_sql, limit_applied) = apply_default_limit(sql, super::DEFAULT_ROW_LIMIT);

        // Manual BEGIN/ROLLBACK (rather than `Client::transaction()`, which
        // needs `&mut Client`) for the same `&self`-method reason as
        // `delete_row_cascade` below. This is the actual enforcement against
        // a model-generated query attempting to mutate data: Postgres itself
        // rejects INSERT/UPDATE/DELETE/DDL inside a READ ONLY transaction
        // regardless of how the SQL is phrased, so nothing here needs to
        // parse or guess at the statement's intent.
        self.client
            .batch_execute("BEGIN READ ONLY")
            .await
            .map_err(map_query_err)?;

        let start = Instant::now();
        let result = self.client.simple_query(&final_sql).await;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        // Always rolled back, even on success — this path exists purely to
        // read. Best-effort: if the rollback itself fails (e.g. the
        // connection dropped), `result` is still what gets surfaced.
        let _ = self.client.batch_execute("ROLLBACK").await;

        let messages = result.map_err(map_query_err)?;
        Ok(simple_query_messages_to_result(sql, messages, elapsed_ms, limit_applied))
    }

    fn select_top_sql(
        &self,
        schema: &str,
        table: &str,
        filter: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> String {
        let mut sql = format!(
            "SELECT * FROM {}.{}",
            quote_ident(schema),
            quote_ident(table)
        );
        if let Some(f) = filter {
            let f = f.trim();
            if !f.is_empty() {
                sql.push_str("\nWHERE ");
                sql.push_str(f);
            }
        }
        sql.push_str(&format!("\nLIMIT {limit}"));
        if offset > 0 {
            sql.push_str(&format!(" OFFSET {offset}"));
        }
        sql.push(';');
        sql
    }

    async fn update_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[ColumnValue],
        changes: &[ColumnValue],
    ) -> Result<(), DbError> {
        if changes.is_empty() {
            return Ok(());
        }
        if primary_key.is_empty() {
            // The frontend gates editing on a detected primary key, so this
            // should be unreachable — but never build an unscoped UPDATE.
            return Err(DbError::new(
                DbErrorKind::Internal,
                "Cannot update a row without a primary key.",
            ));
        }

        // Values are embedded as quoted SQL literals (via `quote_literal`),
        // not bind parameters. This looks unusual, but typed bind parameters
        // don't actually work here: whatever type is declared for `$N` — even
        // Postgres's own UNKNOWN pseudo-type via `prepare_typed` — gets
        // resolved to a concrete type by the server during DESCRIBE (e.g.
        // int4 for `id = $1`), and tokio-postgres's client-side `ToSql` then
        // rejects our generic `String` values against that resolved type
        // before the query is even sent. A literal, by contrast, is coerced
        // by context the same way `id = '1'` already works for the WHERE
        // filter bar — uniformly, for any column type. Identifiers go through
        // `quote_ident`; values go through `quote_literal`; nothing is ever
        // interpolated unescaped.
        let mut sql = format!("UPDATE {}.{} SET ", quote_ident(schema), quote_ident(table));

        for (i, change) in changes.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            // `None` means SQL NULL — a bare keyword, never a quoted 'NULL'
            // string, so a column can actually be nulled rather than set to
            // the literal text "NULL".
            match &change.value {
                Some(v) => sql.push_str(&format!(
                    "{} = {}",
                    quote_ident(&change.column),
                    quote_literal(v)
                )),
                None => sql.push_str(&format!("{} = NULL", quote_ident(&change.column))),
            }
        }

        sql.push_str(" WHERE ");
        for (i, key) in primary_key.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            match &key.value {
                Some(v) => sql.push_str(&format!(
                    "{} = {}",
                    quote_ident(&key.column),
                    quote_literal(v)
                )),
                // `= NULL` never matches in SQL; a NULL key must use `IS NULL`.
                None => sql.push_str(&format!("{} IS NULL", quote_ident(&key.column))),
            }
        }

        let affected = self.client.execute(&sql, &[]).await.map_err(map_query_err)?;

        if affected == 0 {
            return Err(DbError::new(
                DbErrorKind::Query,
                "No matching row found — it may have been changed or deleted elsewhere since this table was loaded. Refresh and try again.",
            ));
        }
        if affected > 1 {
            // Should be impossible with a genuine primary key; refuse rather
            // than silently apply the edit to more than the intended row.
            return Err(DbError::new(
                DbErrorKind::Internal,
                format!(
                    "Update matched {affected} rows instead of 1 — refusing to apply. This table's primary key may not be unique."
                ),
            ));
        }

        Ok(())
    }

    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[ColumnValue],
    ) -> Result<(), DbError> {
        // Values are embedded as quoted SQL literals for the same reason as
        // `update_row` — see the long note there. Identifiers go through
        // `quote_ident`, values through `quote_literal`; NULL is a bare keyword.
        let target = format!("{}.{}", quote_ident(schema), quote_ident(table));

        let sql = if values.is_empty() {
            // A blank draft row — let every column take its database default.
            format!("INSERT INTO {target} DEFAULT VALUES")
        } else {
            let mut cols = String::new();
            let mut vals = String::new();
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    cols.push_str(", ");
                    vals.push_str(", ");
                }
                cols.push_str(&quote_ident(&v.column));
                match &v.value {
                    Some(val) => vals.push_str(&quote_literal(val)),
                    None => vals.push_str("NULL"),
                }
            }
            format!("INSERT INTO {target} ({cols}) VALUES ({vals})")
        };

        self.client.execute(&sql, &[]).await.map_err(map_query_err)?;
        Ok(())
    }

    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[ColumnValue],
    ) -> Result<(), DbError> {
        if primary_key.is_empty() {
            // Gated on a detected primary key in the frontend; never build an
            // unscoped DELETE that would wipe the whole table.
            return Err(DbError::new(
                DbErrorKind::Internal,
                "Cannot delete a row without a primary key.",
            ));
        }

        let mut sql = format!("DELETE FROM {}.{} WHERE ", quote_ident(schema), quote_ident(table));
        for (i, key) in primary_key.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            match &key.value {
                Some(v) => sql.push_str(&format!(
                    "{} = {}",
                    quote_ident(&key.column),
                    quote_literal(v)
                )),
                // `= NULL` never matches in SQL; a NULL key must use `IS NULL`.
                None => sql.push_str(&format!("{} IS NULL", quote_ident(&key.column))),
            }
        }

        let affected = self.client.execute(&sql, &[]).await.map_err(map_query_err)?;

        if affected == 0 {
            return Err(DbError::new(
                DbErrorKind::Query,
                "No matching row found — it may have already been deleted elsewhere. Refresh and try again.",
            ));
        }
        if affected > 1 {
            return Err(DbError::new(
                DbErrorKind::Internal,
                format!(
                    "Delete matched {affected} rows instead of 1 — refusing. This table's primary key may not be unique."
                ),
            ));
        }

        Ok(())
    }

    async fn delete_impact(
        &self,
        schema: &str,
        table: &str,
        primary_keys: &[Vec<ColumnValue>],
    ) -> Result<DeleteImpact, DbError> {
        let Some((pk_columns, pk_values)) = flatten_primary_keys(primary_keys) else {
            return Ok(DeleteImpact { dependents: Vec::new(), incomplete: false });
        };
        compute_delete_impact(&self.client, schema, table, &pk_columns, &pk_values).await
    }

    async fn delete_row_cascade(
        &self,
        schema: &str,
        table: &str,
        primary_keys: &[Vec<ColumnValue>],
    ) -> Result<u64, DbError> {
        let Some((pk_columns, pk_values)) = flatten_primary_keys(primary_keys) else {
            return Err(DbError::new(
                DbErrorKind::Internal,
                "Cannot delete a row without a primary key.",
            ));
        };

        // Manual BEGIN/COMMIT/ROLLBACK (rather than `Client::transaction()`,
        // which needs `&mut Client`) so this stays a `&self` method like
        // every other one on this trait — `AppState.active`'s mutex already
        // guarantees exclusive access to this connection for a command's
        // whole duration (see its doc comment in `state.rs`), so there's no
        // risk of another query interleaving with these statements.
        self.client.batch_execute("BEGIN").await.map_err(map_query_err)?;
        let result = delete_cascade_within_transaction(&self.client, schema, table, &pk_columns, &pk_values).await;
        match result {
            Ok(total) => {
                self.client.batch_execute("COMMIT").await.map_err(map_query_err)?;
                Ok(total)
            }
            Err(e) => {
                // Best-effort — if the rollback itself fails (e.g. the
                // connection dropped), the original error is still what
                // gets surfaced, not this one.
                let _ = self.client.batch_execute("ROLLBACK").await;
                Err(e)
            }
        }
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        let col_rows = self
            .client
            .query(STRUCTURE_COLUMNS_SQL, &[&schema, &table])
            .await
            .map_err(map_query_err)?;
        let columns = col_rows
            .iter()
            .map(|r| StructureColumn {
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.get(2),
                is_primary_key: r.get(3),
                default_expr: r.get(4),
            })
            .collect();

        let index_rows = self
            .client
            .query(STRUCTURE_INDEXES_SQL, &[&schema, &table])
            .await
            .map_err(map_query_err)?;
        let indexes = index_rows
            .iter()
            .map(|r| IndexDetail {
                name: r.get(0),
                definition: r.get(1),
            })
            .collect();

        let check_rows = self
            .client
            .query(STRUCTURE_CHECK_CONSTRAINTS_SQL, &[&schema, &table])
            .await
            .map_err(map_query_err)?;
        let check_constraints = check_rows
            .iter()
            .map(|r| CheckConstraintDetail {
                name: r.get(0),
                definition: r.get(1),
            })
            .collect();

        Ok(TableStructure { columns, indexes, check_constraints })
    }

    async fn function_definition(&self, oid: i64) -> Result<FunctionDefinition, DbError> {
        let row = self
            .client
            .query_one(FUNCTION_DEFINITION_SQL, &[&oid])
            .await
            .map_err(map_query_err)?;
        Ok(FunctionDefinition { definition: row.get(0) })
    }

    async fn sequence_details(&self, schema: &str, name: &str) -> Result<SequenceDetails, DbError> {
        let row = self
            .client
            .query_one(SEQUENCE_DETAILS_SQL, &[&schema, &name])
            .await
            .map_err(map_query_err)?;
        Ok(SequenceDetails {
            data_type: row.get(0),
            start_value: row.get(1),
            min_value: row.get(2),
            max_value: row.get(3),
            increment_by: row.get(4),
            cycle: row.get(5),
            cache_size: row.get(6),
            last_value: row.get(7),
        })
    }

    fn canceller(&self) -> Box<dyn QueryCanceller> {
        Box::new(PostgresCanceller {
            token: self.client.cancel_token(),
        })
    }
}

/// Cancels whatever is running on the [`PostgresSession`] it came from, via
/// Postgres's native cancel-request protocol on a fresh, independent
/// connection — this is why it works even while the original session's
/// `run_query` is still in-flight (unlike every other operation on a session,
/// which the caller serializes by holding `AppState.active`'s lock).
struct PostgresCanceller {
    token: tokio_postgres::CancelToken,
}

#[async_trait]
impl QueryCanceller for PostgresCanceller {
    async fn cancel(&self) -> Result<(), DbError> {
        let connector = tls_connector()?;
        self.token.cancel_query(connector).await.map_err(map_conn_err)
    }
}

/// Build the TLS connector used for every Postgres connection this driver
/// opens, including the out-of-band connection a `CancelToken` needs. Cheap
/// and purely local — no I/O — so callers can build a fresh one whenever
/// needed rather than having to thread one through.
fn tls_connector() -> Result<postgres_native_tls::MakeTlsConnector, DbError> {
    // native-tls uses the OS trust store; combined with sslmode=prefer this
    // negotiates TLS when the server offers it and falls back to plaintext.
    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| DbError::new(DbErrorKind::Connection, format!("TLS setup failed: {e}")))?;
    Ok(postgres_native_tls::MakeTlsConnector::new(tls))
}

/// Connect, spawn the connection driver task, and read the server version.
async fn establish(params: &ConnectionParams) -> Result<(tokio_postgres::Client, ConnectionInfo), DbError> {
    let config = build_config(params)?;
    let connector = tls_connector()?;

    let start = Instant::now();
    let (client, connection) = config.connect(connector).await.map_err(map_conn_err)?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // The connection object must be driven for the client to make progress.
    // No secrets are logged if it later errors out.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("[cubbydb] postgres connection closed: {e}");
        }
    });

    let version_row = client
        .query_one("SHOW server_version", &[])
        .await
        .map_err(map_conn_err)?;
    let server_version: String = version_row.get(0);

    Ok((
        client,
        ConnectionInfo {
            engine: Engine::Postgres,
            server_version,
            elapsed_ms,
        },
    ))
}

/// Assemble a `tokio_postgres::Config` from either a connection string or the
/// individual fields.
fn build_config(params: &ConnectionParams) -> Result<Config, DbError> {
    if let Some(cs) = params.connection_string.as_deref() {
        let cs = cs.trim();
        if !cs.is_empty() {
            return cs.parse::<Config>().map_err(|e| {
                DbError::new(
                    DbErrorKind::Connection,
                    format!("Invalid connection string: {e}"),
                )
            });
        }
    }

    let mut config = Config::new();
    config.host(params.host.as_deref().unwrap_or("localhost"));
    config.port(params.port.unwrap_or(5432));

    // libpq requires a user; fall back to the OS user like psql does.
    let user = params
        .user
        .clone()
        .filter(|u| !u.is_empty())
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("LOGNAME").ok())
        .unwrap_or_else(|| "postgres".to_string());
    config.user(&user);

    if let Some(db) = params.database.as_deref().filter(|d| !d.is_empty()) {
        config.dbname(db);
    }
    if let Some(pw) = params.password.as_deref().filter(|p| !p.is_empty()) {
        config.password(pw);
    }

    Ok(config)
}

/// Append a default `LIMIT` to an unbounded single-statement SELECT.
///
/// Conservative on purpose: only a single `select`/`with` statement with no
/// existing `limit` is touched. Anything else is passed through untouched, so we
/// never change the meaning of a query we don't fully understand.
fn apply_default_limit(sql: &str, limit: u32) -> (String, bool) {
    let trimmed = sql.trim().trim_end_matches(';');
    let trimmed = trimmed.trim();

    // Bail on multiple statements — running them verbatim is safer than guessing.
    if trimmed.contains(';') {
        return (sql.to_string(), false);
    }

    let lower = trimmed.to_lowercase();
    let is_select = lower.starts_with("select") || lower.starts_with("with");
    if !is_select || contains_word(&lower, "limit") {
        return (sql.to_string(), false);
    }

    (format!("{trimmed}\nLIMIT {limit}"), true)
}

/// Whole-word, case-insensitive search (operates on already-lowercased input).
fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(word) {
        let start = from + pos;
        let end = start + word.len();
        let before_ok = start == 0 || !is_ident_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_ident_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The leading SQL verb, uppercased, for a command tag (e.g. `UPDATE`).
fn leading_verb(sql: &str) -> String {
    sql.trim()
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_uppercase()
}

/// Shared by `run_query` and `run_read_only_query`: turns `simple_query`'s
/// message stream into a `QueryResult`. `sql` is the *original* (pre-limit)
/// text, used only to infer the command tag's verb.
fn simple_query_messages_to_result(
    sql: &str,
    messages: Vec<SimpleQueryMessage>,
    elapsed_ms: u64,
    limit_applied: bool,
) -> QueryResult {
    let mut columns: Vec<ResultColumn> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut affected: Option<u64> = None;

    for message in messages {
        match message {
            // Postgres sends the column list before any row data — including
            // when the query matches zero rows. Relying on this (rather than
            // the first `Row`) is what lets an empty result set still report
            // its columns instead of looking like a non-row-returning statement.
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols
                    .iter()
                    .map(|c| ResultColumn {
                        name: c.name().to_string(),
                    })
                    .collect();
            }
            SimpleQueryMessage::Row(row) => {
                let values = (0..row.len())
                    .map(|i| row.get(i).map(|v| v.to_string()))
                    .collect();
                rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(n) => {
                affected = Some(n);
            }
            // The message enum is non-exhaustive; ignore anything else.
            _ => {}
        }
    }

    // A row-returning statement yields columns; otherwise report the command
    // tag (verb inferred from the SQL, count from the server).
    let command_tag = if columns.is_empty() {
        affected.map(|n| format!("{} {}", leading_verb(sql), n))
    } else {
        None
    };

    QueryResult {
        row_count: rows.len(),
        columns,
        rows,
        elapsed_ms,
        command_tag,
        limit_applied,
    }
}

/// Double-quote an identifier, escaping embedded quotes.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote a value as a SQL string literal, doubling embedded single quotes —
/// the standard SQL escaping rule (matches Postgres's own `quote_literal()`
/// SQL function). Assumes `standard_conforming_strings`, Postgres's default
/// since 9.1, so backslashes need no special handling.
fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

// --- Delete impact / cascade -----------------------------------------------
//
// Before deleting a row, walk the foreign-key graph to find every other row
// that references it (transitively — dependents of dependents), so the
// frontend can show what would cascade instead of the delete just failing
// with a raw FK-violation error. Bounded by `MAX_DEPTH`/`MAX_TOTAL_ROWS` so
// it can never turn into an unbounded walk or an unbounded delete.
//
// Scope limitation: only handles foreign keys that reference a table's
// *primary key* (checked via `reorder_values_for` matching the FK's
// referenced columns against the level's PK column set exactly) — a FK
// referencing some other unique constraint is skipped. This covers the
// overwhelming majority of real schemas without needing to enumerate every
// unique constraint too.

/// Below this many cascade levels, or above this many total dependent rows
/// examined, the walk stops rather than continuing indefinitely.
const MAX_DEPTH: usize = 5;
const MAX_TOTAL_ROWS: i64 = 500;
/// How many example rows are fetched per dependent table for the preview —
/// deliberately small; `total_count` (a real `count(*)`) carries the true
/// number regardless of how many rows are sampled.
const SAMPLE_LIMIT: i64 = 10;

/// Every FK constraint pointing *at* one table, grouped by constraint (not
/// unnested per-column like `FOREIGN_KEYS_SQL`) so composite keys stay
/// associated as a unit.
const CONSTRAINTS_REFERENCING_SQL: &str = "
    SELECT
        fns.nspname                                  AS dep_schema,
        fcl.relname                                  AS dep_table,
        con.conname                                  AS constraint_name,
        array_agg(att.attname ORDER BY k.ord)        AS dep_columns,
        array_agg(ratt.attname ORDER BY k.ord)        AS ref_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cl ON cl.oid = con.confrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_catalog.pg_class fcl ON fcl.oid = con.conrelid
    JOIN pg_catalog.pg_namespace fns ON fns.oid = fcl.relnamespace
    JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(dep_attnum, ref_attnum, ord)
        ON true
    JOIN pg_catalog.pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = k.dep_attnum
    JOIN pg_catalog.pg_attribute ratt
        ON ratt.attrelid = con.confrelid AND ratt.attnum = k.ref_attnum
    WHERE con.contype = 'f' AND ns.nspname = $1 AND cl.relname = $2
    GROUP BY fns.nspname, fcl.relname, con.conname
    ORDER BY fns.nspname, fcl.relname
";

/// A table's own primary-key columns, in index-key order — reused for every
/// table encountered while walking the graph (both the root table and every
/// dependent table found along the way).
const TABLE_PRIMARY_KEY_SQL: &str = "
    SELECT a.attname
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
";

struct FkConstraintInfo {
    dep_schema: String,
    dep_table: String,
    constraint_name: String,
    dep_columns: Vec<String>,
    ref_columns: Vec<String>,
}

async fn constraints_referencing(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<FkConstraintInfo>, DbError> {
    let rows = client
        .query(CONSTRAINTS_REFERENCING_SQL, &[&schema, &table])
        .await
        .map_err(map_query_err)?;
    Ok(rows
        .iter()
        .map(|r| FkConstraintInfo {
            dep_schema: r.get(0),
            dep_table: r.get(1),
            constraint_name: r.get(2),
            dep_columns: r.get(3),
            ref_columns: r.get(4),
        })
        .collect())
}

async fn table_primary_key_columns(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, DbError> {
    let rows = client
        .query(TABLE_PRIMARY_KEY_SQL, &[&schema, &table])
        .await
        .map_err(map_query_err)?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Flattens the frontend's per-row `Vec<ColumnValue>` primary keys into a
/// shared column-name list plus one value-tuple per row — `None` if any row
/// has no primary key at all (deletion is gated on a detected PK elsewhere,
/// but this stays defensive rather than building an unscoped clause).
fn flatten_primary_keys(
    primary_keys: &[Vec<ColumnValue>],
) -> Option<(Vec<String>, Vec<Vec<Option<String>>>)> {
    if primary_keys.is_empty() || primary_keys.iter().any(|pk| pk.is_empty()) {
        return None;
    }
    let columns = primary_keys[0].iter().map(|c| c.column.clone()).collect();
    let values = primary_keys
        .iter()
        .map(|pk| pk.iter().map(|c| c.value.clone()).collect())
        .collect();
    Some((columns, values))
}

/// Builds `(col1, col2) IN ((v1a,v1b), (v2a,v2b), ...)`, handling single- and
/// multi-column keys uniformly. Values are inlined via [`quote_literal`]
/// (matching how `delete_row`/`update_row` already build their WHERE
/// clauses) rather than bound as query parameters — the sample/discovery
/// queries this feeds into run over `simple_query`, which returns every
/// value already as text and doesn't support parameter placeholders at all.
fn build_row_value_in(columns: &[String], key_sets: &[Vec<Option<String>>]) -> String {
    let col_list = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let tuples: Vec<String> = key_sets
        .iter()
        .map(|row| {
            let vals: Vec<String> = row
                .iter()
                .map(|v| match v {
                    Some(s) => quote_literal(s),
                    // A primary-key value is never actually NULL (PK columns
                    // are NOT NULL by definition) — handled anyway so this
                    // never silently mis-renders if that ever changes.
                    None => "NULL".to_string(),
                })
                .collect();
            format!("({})", vals.join(", "))
        })
        .collect();
    format!("({}) IN ({})", col_list, tuples.join(", "))
}

/// Reorders `values` (tuples matching `key_columns`'s order) to match
/// `target_order` instead. Returns `None` if `target_order` isn't exactly
/// the same *set* of columns as `key_columns` — meaning a FK references some
/// other unique constraint, not the key currently being walked — out of
/// scope per this module's doc comment, so the caller skips it rather than
/// matching it incorrectly.
fn reorder_values_for(
    key_columns: &[String],
    target_order: &[String],
    values: &[Vec<Option<String>>],
) -> Option<Vec<Vec<Option<String>>>> {
    if key_columns.len() != target_order.len() {
        return None;
    }
    let mut positions = Vec::with_capacity(target_order.len());
    for col in target_order {
        positions.push(key_columns.iter().position(|c| c == col)?);
    }
    Some(
        values
            .iter()
            .map(|row| positions.iter().map(|&p| row[p].clone()).collect())
            .collect(),
    )
}

/// Runs `sql` over `simple_query` and returns the first row's first column
/// as an integer, defaulting to 0 — used for `count(*)` queries, which
/// always return exactly one row.
async fn simple_query_scalar_count(client: &Client, sql: &str) -> Result<i64, DbError> {
    let messages = client.simple_query(sql).await.map_err(map_query_err)?;
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            return Ok(row.get(0).and_then(|s| s.parse().ok()).unwrap_or(0));
        }
    }
    Ok(0)
}

/// Runs `sql` over `simple_query` and collects its column names and rows —
/// the same parsing shape `run_query` already uses, factored out so the
/// delete-impact walk can reuse it.
async fn simple_query_rows(
    client: &Client,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), DbError> {
    let messages = client.simple_query(sql).await.map_err(map_query_err)?;
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    for message in messages {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
            }
            SimpleQueryMessage::Row(row) => {
                let values = (0..row.len()).map(|i| row.get(i).map(|v| v.to_string())).collect();
                rows.push(values);
            }
            _ => {}
        }
    }
    Ok((columns, rows))
}

/// Read-only preview: walks the FK graph breadth-first, fetching a small
/// sample plus a true count at each dependent table, and assembles the
/// result into the nested tree the frontend renders. The graph walk itself
/// is iterative (a work queue, not recursion) specifically so it can `.await`
/// freely without hitting Rust's "recursive async fn" sizing problem; once
/// all the I/O is done, the flat node list is assembled into a tree via
/// ordinary *synchronous* recursion (line at the bottom), which has no such
/// restriction.
async fn compute_delete_impact(
    client: &Client,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values: &[Vec<Option<String>>],
) -> Result<DeleteImpact, DbError> {
    struct Node {
        parent: Option<usize>,
        preview: DependentRowsPreview,
    }
    let mut nodes: Vec<Node> = Vec::new();
    let mut queue: VecDeque<(Option<usize>, String, String, Vec<String>, Vec<Vec<Option<String>>>, usize)> =
        VecDeque::new();
    queue.push_back((None, schema.to_string(), table.to_string(), pk_columns.to_vec(), pk_values.to_vec(), 0));

    let mut budget: i64 = MAX_TOTAL_ROWS;
    let mut incomplete = false;

    while let Some((parent, cur_schema, cur_table, cur_pk_cols, cur_pk_vals, depth)) = queue.pop_front() {
        if cur_pk_vals.is_empty() || cur_pk_cols.is_empty() {
            continue;
        }
        if depth >= MAX_DEPTH {
            incomplete = true;
            continue;
        }

        for fk in constraints_referencing(client, &cur_schema, &cur_table).await? {
            if budget <= 0 {
                incomplete = true;
                break;
            }
            let Some(reordered) = reorder_values_for(&cur_pk_cols, &fk.ref_columns, &cur_pk_vals) else {
                continue;
            };
            let in_clause = build_row_value_in(&fk.dep_columns, &reordered);

            let count_sql = format!(
                "SELECT count(*) FROM {}.{} WHERE {}",
                quote_ident(&fk.dep_schema),
                quote_ident(&fk.dep_table),
                in_clause
            );
            let total_count = simple_query_scalar_count(client, &count_sql).await?;
            if total_count == 0 {
                continue;
            }

            let sample_sql = format!(
                "SELECT * FROM {}.{} WHERE {} LIMIT {SAMPLE_LIMIT}",
                quote_ident(&fk.dep_schema),
                quote_ident(&fk.dep_table),
                in_clause
            );
            let (columns, sample_rows) = simple_query_rows(client, &sample_sql).await?;
            let truncated = total_count > sample_rows.len() as i64;
            if truncated {
                // The unsampled remainder's own dependents are never
                // explored, so anything below this node is an
                // approximation — reflected honestly rather than hidden.
                incomplete = true;
            }
            budget -= sample_rows.len() as i64;

            let node_idx = nodes.len();
            nodes.push(Node {
                parent,
                preview: DependentRowsPreview {
                    schema: fk.dep_schema.clone(),
                    table: fk.dep_table.clone(),
                    fk_constraint: fk.constraint_name,
                    columns: columns.clone(),
                    sample_rows: sample_rows.clone(),
                    total_count,
                    truncated,
                    children: Vec::new(), // filled in once the tree is assembled below
                },
            });

            let dep_pk = table_primary_key_columns(client, &fk.dep_schema, &fk.dep_table).await?;
            if dep_pk.is_empty() {
                continue; // no usable key to recurse with — this branch ends here
            }
            let Some(positions) = dep_pk
                .iter()
                .map(|c| columns.iter().position(|x| x == c))
                .collect::<Option<Vec<_>>>()
            else {
                continue;
            };
            let next_values: Vec<Vec<Option<String>>> = sample_rows
                .iter()
                .map(|row| positions.iter().map(|&p| row[p].clone()).collect())
                .collect();
            queue.push_back((Some(node_idx), fk.dep_schema, fk.dep_table, dep_pk, next_values, depth + 1));
        }
    }

    fn build_children(nodes: &[Node], parent_idx: Option<usize>) -> Vec<DependentRowsPreview> {
        nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.parent == parent_idx)
            .map(|(i, n)| {
                let mut preview = n.preview.clone();
                preview.children = build_children(nodes, Some(i));
                preview
            })
            .collect()
    }

    Ok(DeleteImpact { dependents: build_children(&nodes, None), incomplete })
}

/// One step of an actual cascade delete: every row in `schema.table` whose
/// `delete_columns` match one of `delete_values` will be deleted.
struct CascadeStep {
    schema: String,
    table: String,
    delete_columns: Vec<String>,
    delete_values: Vec<Vec<Option<String>>>,
}

/// Full (unsampled) discovery pass for an actual cascade delete — same graph
/// walk as [`compute_delete_impact`], but fetching every matching row's
/// primary key rather than a capped sample, since a real delete can't skip
/// rows just because a preview would have. Still bounded by the same
/// `MAX_DEPTH`/`MAX_TOTAL_ROWS`, but here that means refusing outright
/// (returning an error, before any `DELETE` is issued) rather than marking
/// the result `incomplete` — a cascade delete either fully accounts for
/// everything it's about to remove, or it doesn't run at all.
async fn discover_full_cascade(
    client: &Client,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values: &[Vec<Option<String>>],
) -> Result<Vec<CascadeStep>, DbError> {
    let mut steps: Vec<CascadeStep> = Vec::new();
    let mut queue: VecDeque<(String, String, Vec<String>, Vec<Vec<Option<String>>>, usize)> = VecDeque::new();
    queue.push_back((schema.to_string(), table.to_string(), pk_columns.to_vec(), pk_values.to_vec(), 0));

    let mut budget: i64 = MAX_TOTAL_ROWS;

    while let Some((cur_schema, cur_table, cur_pk_cols, cur_pk_vals, depth)) = queue.pop_front() {
        if cur_pk_vals.is_empty() || cur_pk_cols.is_empty() {
            continue;
        }
        if depth >= MAX_DEPTH {
            return Err(DbError::new(
                DbErrorKind::Internal,
                format!(
                    "This delete cascades deeper than {MAX_DEPTH} levels — refusing for safety. \
                     Delete the deepest related rows manually first, then try again."
                ),
            ));
        }

        for fk in constraints_referencing(client, &cur_schema, &cur_table).await? {
            let Some(reordered) = reorder_values_for(&cur_pk_cols, &fk.ref_columns, &cur_pk_vals) else {
                continue;
            };
            let in_clause = build_row_value_in(&fk.dep_columns, &reordered);

            let dep_pk = table_primary_key_columns(client, &fk.dep_schema, &fk.dep_table).await?;
            let select_cols = if dep_pk.is_empty() { fk.dep_columns.clone() } else { dep_pk.clone() };
            let select_list = select_cols.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT {} FROM {}.{} WHERE {}",
                select_list,
                quote_ident(&fk.dep_schema),
                quote_ident(&fk.dep_table),
                in_clause
            );
            let (_, rows) = simple_query_rows(client, &sql).await?;
            if rows.is_empty() {
                continue;
            }

            budget -= rows.len() as i64;
            if budget < 0 {
                return Err(DbError::new(
                    DbErrorKind::Internal,
                    format!(
                        "This delete would cascade to more than {MAX_TOTAL_ROWS} rows — refusing \
                         for safety. Narrow the selection or delete related rows manually first."
                    ),
                ));
            }

            steps.push(CascadeStep {
                schema: fk.dep_schema.clone(),
                table: fk.dep_table.clone(),
                delete_columns: fk.dep_columns,
                delete_values: reordered,
            });

            if !dep_pk.is_empty() {
                queue.push_back((fk.dep_schema, fk.dep_table, dep_pk, rows, depth + 1));
            }
        }
    }

    Ok(steps)
}

/// Runs the discovery pass and issues the actual `DELETE`s, deepest
/// dependents first and the requested rows last, so nothing is ever
/// half-cascaded. Assumes a transaction is already open on `client` (see
/// [`DbSession::delete_row_cascade`]) — this function itself never commits
/// or rolls back.
async fn delete_cascade_within_transaction(
    client: &Client,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values: &[Vec<Option<String>>],
) -> Result<u64, DbError> {
    let steps = discover_full_cascade(client, schema, table, pk_columns, pk_values).await?;

    let mut total: u64 = 0;
    for step in steps.iter().rev() {
        let in_clause = build_row_value_in(&step.delete_columns, &step.delete_values);
        let sql = format!(
            "DELETE FROM {}.{} WHERE {}",
            quote_ident(&step.schema),
            quote_ident(&step.table),
            in_clause
        );
        total += client.execute(&sql, &[]).await.map_err(map_query_err)?;
    }

    let root_clause = build_row_value_in(pk_columns, pk_values);
    let root_sql = format!("DELETE FROM {}.{} WHERE {}", quote_ident(schema), quote_ident(table), root_clause);
    total += client.execute(&root_sql, &[]).await.map_err(map_query_err)?;

    Ok(total)
}

/// Map a connection-time Postgres error, preserving SQLSTATE when present.
fn map_conn_err(e: tokio_postgres::Error) -> DbError {
    let mut err = map_db_error(e, DbErrorKind::Connection);
    err.kind = DbErrorKind::Connection;
    err
}

/// Map a query-time Postgres error, preserving SQLSTATE / hint / position.
fn map_query_err(e: tokio_postgres::Error) -> DbError {
    map_db_error(e, DbErrorKind::Query)
}

fn map_db_error(e: tokio_postgres::Error, kind: DbErrorKind) -> DbError {
    if let Some(db) = e.as_db_error() {
        let position = match db.position() {
            Some(ErrorPosition::Original(p)) => Some(*p),
            Some(ErrorPosition::Internal { position, .. }) => Some(*position),
            None => None,
        };
        DbError {
            message: db.message().to_string(),
            code: Some(db.code().code().to_string()),
            hint: db.hint().map(|s| s.to_string()),
            position,
            kind,
        }
    } else {
        // No SQLSTATE means a transport-level failure. If the connection was
        // closed, tag it so callers can transparently reconnect and retry.
        let kind = if e.is_closed() {
            DbErrorKind::Connection
        } else {
            kind
        };
        // Some of tokio-postgres's own errors (e.g. parameter encoding
        // failures) only put a generic summary in `Display` and leave the
        // actual reason in the `source()` chain — surface that too, rather
        // than showing the user an uninformative "error serializing
        // parameter 1" with no explanation of what was actually wrong.
        let mut message = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(err) = source {
            message.push_str(": ");
            message.push_str(&err.to_string());
            source = err.source();
        }
        DbError::new(kind, message)
    }
}

// --- Catalog queries -------------------------------------------------------

/// User-visible schemas (system schemas filtered out), alphabetical.
const SCHEMA_LIST_SQL: &str = "
    SELECT n.nspname
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname
";

/// Every column of every table/view in user schemas, with type, nullability,
/// primary-key membership, and the relation's estimated row count.
const SCHEMA_COLUMNS_SQL: &str = "
    SELECT
        n.nspname                                   AS schema_name,
        c.relname                                   AS table_name,
        c.relkind::text                             AS relkind,
        a.attname                                   AS column_name,
        format_type(a.atttypid, a.atttypmod)        AS data_type,
        NOT a.attnotnull                            AS nullable,
        COALESCE(pk.is_pk, false)                   AS is_primary_key,
        CASE WHEN c.reltuples < 0 THEN NULL
             ELSE c.reltuples::bigint END           AS estimated_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN LATERAL (
        SELECT true AS is_pk
        FROM pg_catalog.pg_index i
        WHERE i.indrelid = c.oid AND i.indisprimary
          AND a.attnum = ANY (i.indkey)
        LIMIT 1
    ) pk ON true
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname, c.relname, a.attnum
";

/// Foreign-key relationships: each referencing column paired with the column it
/// points at. Multi-column keys are unnested so each (local, foreign) column
/// pair is one row.
const FOREIGN_KEYS_SQL: &str = "
    SELECT
        ns.nspname   AS schema_name,
        cl.relname   AS table_name,
        att.attname  AS column_name,
        fns.nspname  AS ref_schema,
        fcl.relname  AS ref_table,
        fatt.attname AS ref_column
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_catalog.pg_class fcl ON fcl.oid = c.confrelid
    JOIN pg_catalog.pg_namespace fns ON fns.oid = fcl.relnamespace
    JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(local_attnum, ref_attnum, ord)
        ON true
    JOIN pg_catalog.pg_attribute att
        ON att.attrelid = c.conrelid AND att.attnum = k.local_attnum
    JOIN pg_catalog.pg_attribute fatt
        ON fatt.attrelid = c.confrelid AND fatt.attnum = k.ref_attnum
    WHERE c.contype = 'f'
      AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ns.nspname NOT LIKE 'pg_toast%'
      AND ns.nspname NOT LIKE 'pg_temp%'
";

/// Functions and procedures in user schemas (aggregates/window functions
/// excluded — see `FunctionNode`'s doc comment for why). `oid` is cast to
/// `bigint` so it comes back as a plain `i64` rather than the Postgres `oid`
/// type, which has no built-in `tokio-postgres` Rust mapping.
const FUNCTIONS_SQL: &str = "
    SELECT
        n.nspname                                   AS schema_name,
        p.oid::bigint                                AS oid,
        p.proname                                    AS name,
        pg_get_function_arguments(p.oid)             AS arguments,
        CASE WHEN p.prokind = 'p' THEN NULL
             ELSE pg_get_function_result(p.oid) END  AS return_type,
        p.prokind::text                              AS prokind
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname, p.proname
";

/// Sequences in user schemas, with the table/column they're `OWNED BY` (the
/// mechanism behind `SERIAL`/`GENERATED ... AS IDENTITY` columns), if any —
/// found via `pg_depend`'s auto-dependency (`deptype = 'a'`) rather than
/// hand-parsing anything.
const SEQUENCES_SQL: &str = "
    SELECT
        n.nspname          AS schema_name,
        c.relname          AS name,
        owner_tab.relname  AS owner_table,
        owner_col.attname  AS owner_column
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_depend d
        ON d.objid = c.oid
       AND d.classid = 'pg_catalog.pg_class'::regclass
       AND d.refclassid = 'pg_catalog.pg_class'::regclass
       AND d.deptype = 'a'
    LEFT JOIN pg_catalog.pg_class owner_tab ON owner_tab.oid = d.refobjid
    LEFT JOIN pg_catalog.pg_attribute owner_col
        ON owner_col.attrelid = d.refobjid AND owner_col.attnum = d.refobjsubid
    WHERE c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname, c.relname
";

/// Enum types in user schemas, with their values in defined display order.
const ENUM_TYPES_SQL: &str = "
    SELECT
        n.nspname                                        AS schema_name,
        t.typname                                         AS name,
        array_agg(e.enumlabel ORDER BY e.enumsortorder)  AS values
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typtype = 'e'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname
";

/// A function/procedure's full body, by oid ($1) — Postgres's own renderer,
/// so it's always accurate (handles SQL, PL/pgSQL, and other languages alike).
const FUNCTION_DEFINITION_SQL: &str = "SELECT pg_get_functiondef($1::oid)";

/// One sequence's current configuration, straight from the `pg_sequences`
/// system view — no manual computation needed. `data_type` is cast to `text`
/// since its native type (`regtype`) has no built-in `tokio-postgres` mapping.
const SEQUENCE_DETAILS_SQL: &str = "
    SELECT
        data_type::text,
        start_value,
        min_value,
        max_value,
        increment_by,
        cycle,
        cache_size,
        last_value
    FROM pg_catalog.pg_sequences
    WHERE schemaname = $1 AND sequencename = $2
";

// --- "View structure" queries, each scoped to one table via $1 (schema) and
// $2 (table) ------------------------------------------------------------

/// Columns for one table, with type, nullability, PK flag, and default
/// expression. Same shape as `SCHEMA_COLUMNS_SQL` plus `pg_attrdef` for the
/// default — kept as a separate, table-scoped query rather than piggybacking
/// on the whole-schema fetch, since the default expression isn't needed by
/// the tree and computing it for every column in every table on every
/// connect/refresh would be wasted work.
const STRUCTURE_COLUMNS_SQL: &str = "
    SELECT
        a.attname                              AS column_name,
        format_type(a.atttypid, a.atttypmod)   AS data_type,
        NOT a.attnotnull                       AS nullable,
        COALESCE(pk.is_pk, false)              AS is_primary_key,
        pg_get_expr(ad.adbin, ad.adrelid)      AS default_expr
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef ad
        ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    LEFT JOIN LATERAL (
        SELECT true AS is_pk
        FROM pg_catalog.pg_index i
        WHERE i.indrelid = c.oid AND i.indisprimary
          AND a.attnum = ANY (i.indkey)
        LIMIT 1
    ) pk ON true
    WHERE n.nspname = $1 AND c.relname = $2
    ORDER BY a.attnum
";

/// Indexes for one table. `pg_indexes` is a builtin view that already has the
/// full `CREATE INDEX ...` text per index — using it means we never hand-build
/// index DDL ourselves.
const STRUCTURE_INDEXES_SQL: &str = "
    SELECT indexname, indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = $1 AND tablename = $2
    ORDER BY indexname
";

/// CHECK constraints for one table, via Postgres's own constraint-rendering
/// function rather than reconstructing the clause by hand.
const STRUCTURE_CHECK_CONSTRAINTS_SQL: &str = "
    SELECT con.conname, pg_get_constraintdef(con.oid)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'c'
    ORDER BY con.conname
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_limit_to_bare_select() {
        let (sql, applied) = apply_default_limit("SELECT * FROM orders", 100);
        assert!(applied);
        assert!(sql.ends_with("LIMIT 100"));
    }

    #[test]
    fn respects_existing_limit() {
        let (_sql, applied) = apply_default_limit("select * from orders limit 5", 100);
        assert!(!applied);
    }

    #[test]
    fn ignores_non_select() {
        let (_sql, applied) = apply_default_limit("UPDATE orders SET total = 0", 100);
        assert!(!applied);
    }

    #[test]
    fn ignores_multiple_statements() {
        let (_sql, applied) = apply_default_limit("SELECT 1; SELECT 2", 100);
        assert!(!applied);
    }

    #[test]
    fn limit_as_substring_is_not_a_word() {
        // `climationlimit` must not be mistaken for a LIMIT clause.
        assert!(!contains_word("select climitation from t", "limit"));
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn row_value_in_single_column() {
        let cols = vec!["id".to_string()];
        let sets = vec![vec![Some("1".to_string())], vec![Some("2".to_string())]];
        assert_eq!(build_row_value_in(&cols, &sets), "(\"id\") IN (('1'), ('2'))");
    }

    #[test]
    fn row_value_in_composite_and_null() {
        let cols = vec!["a".to_string(), "b".to_string()];
        let sets = vec![vec![Some("1".to_string()), None]];
        assert_eq!(build_row_value_in(&cols, &sets), "(\"a\", \"b\") IN (('1', NULL))");
    }

    #[test]
    fn row_value_in_escapes_literals() {
        let cols = vec!["name".to_string()];
        let sets = vec![vec![Some("O'Brien".to_string())]];
        assert_eq!(build_row_value_in(&cols, &sets), "(\"name\") IN (('O''Brien'))");
    }

    #[test]
    fn reorder_matches_permuted_columns() {
        let key_columns = vec!["a".to_string(), "b".to_string()];
        let target_order = vec!["b".to_string(), "a".to_string()];
        let values = vec![vec![Some("1".to_string()), Some("2".to_string())]];
        let reordered = reorder_values_for(&key_columns, &target_order, &values).unwrap();
        assert_eq!(reordered, vec![vec![Some("2".to_string()), Some("1".to_string())]]);
    }

    #[test]
    fn reorder_rejects_mismatched_column_sets() {
        // A FK referencing some other unique constraint, not this level's
        // primary key — out of scope, so this must return `None` rather than
        // matching the wrong columns.
        let key_columns = vec!["id".to_string()];
        let target_order = vec!["email".to_string()];
        let values = vec![vec![Some("1".to_string())]];
        assert!(reorder_values_for(&key_columns, &target_order, &values).is_none());
    }

    #[test]
    fn flatten_primary_keys_rejects_any_empty_row() {
        let one_ok = vec![ColumnValue { column: "id".to_string(), value: Some("1".to_string()) }];
        let empty: Vec<ColumnValue> = Vec::new();
        assert!(flatten_primary_keys(&[one_ok, empty]).is_none());
    }

    #[test]
    fn flatten_primary_keys_collects_columns_and_values() {
        let row1 = vec![ColumnValue { column: "id".to_string(), value: Some("1".to_string()) }];
        let row2 = vec![ColumnValue { column: "id".to_string(), value: Some("2".to_string()) }];
        let (columns, values) = flatten_primary_keys(&[row1, row2]).unwrap();
        assert_eq!(columns, vec!["id".to_string()]);
        assert_eq!(values, vec![vec![Some("1".to_string())], vec![Some("2".to_string())]]);
    }

    /// Live end-to-end smoke test against a real Postgres. Ignored by default;
    /// run with a database available:
    ///
    ///   CUBBYDB_TEST_DSN="postgresql://user@localhost/db" \
    ///     cargo test --lib -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a running Postgres (set CUBBYDB_TEST_DSN)"]
    async fn live_smoke() {
        use super::super::{ConnectionParams, DatabaseDriver};

        let Ok(dsn) = std::env::var("CUBBYDB_TEST_DSN") else {
            eprintln!("CUBBYDB_TEST_DSN not set; skipping");
            return;
        };

        let driver = PostgresDriver::new();
        let params = ConnectionParams {
            connection_string: Some(dsn),
            ..Default::default()
        };

        // test_connection returns a server version.
        let info = driver.test_connection(&params).await.expect("test_connection");
        assert!(!info.server_version.is_empty());
        eprintln!("connected to Postgres {}", info.server_version);

        // A live session can read the schema and run queries.
        let session = driver.connect(&params).await.expect("connect");
        let schema = session.fetch_schema().await.expect("fetch_schema");
        assert!(!schema.is_empty(), "expected at least one user schema");
        eprintln!(
            "schemas: {:?}",
            schema.iter().map(|s| &s.name).collect::<Vec<_>>()
        );

        // Unbounded SELECT gets a default LIMIT applied.
        let result = session.run_query("SELECT 1 AS n").await.expect("run_query");
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0].as_deref(), Some("1"));

        // A bad query surfaces a structured error with a SQLSTATE.
        let err = session
            .run_query("SELECT nope FROM does_not_exist")
            .await
            .expect_err("expected query error");
        assert!(err.code.is_some(), "expected a SQLSTATE code");
        eprintln!("error path ok: {} ({:?})", err.message, err.code);

        // A SELECT matching zero rows must still report its columns — Postgres
        // sends the column list before any row data, so this must not regress
        // to looking like a non-row-returning statement (a real prior bug).
        let empty = session
            .run_query("SELECT 1 AS n WHERE false")
            .await
            .expect("run_query on zero-row select");
        assert_eq!(empty.rows.len(), 0);
        assert_eq!(
            empty.columns.len(),
            1,
            "expected column metadata even with zero matching rows"
        );
        assert_eq!(empty.columns[0].name, "n");
        eprintln!("zero-row columns ok: {:?}", empty.columns);

        // update_row: a scratch table (a real, normally-schemaed table — not
        // TEMP, since `pg_temp` is a query-time alias that doesn't literally
        // match the catalog's per-session temp namespace name) exercises the
        // real parameterized UPDATE: a numeric primary key (proving the
        // `$N::type` cast fix, since a bare `String` param can't satisfy
        // int4), a value containing a single quote (the classic
        // injection/escaping footgun), and the zero-match error path.
        session
            .run_query("DROP TABLE IF EXISTS cubbydb_edit_test")
            .await
            .expect("drop any leftover scratch table");
        session
            .run_query("CREATE TABLE cubbydb_edit_test (id int PRIMARY KEY, note text)")
            .await
            .expect("create scratch table");
        session
            .run_query("INSERT INTO cubbydb_edit_test (id, note) VALUES (1, 'original')")
            .await
            .expect("seed row");

        use super::super::ColumnValue;
        let pk = |v: &str| ColumnValue {
            column: "id".into(),
            value: Some(v.into()),
        };
        session
            .update_row(
                "public",
                "cubbydb_edit_test",
                &[pk("1")],
                &[ColumnValue {
                    column: "note".into(),
                    value: Some("O'Brien's edit".into()),
                }],
            )
            .await
            .expect("update_row with a numeric PK and a quote in the value");

        let check = session
            .run_query("SELECT note FROM cubbydb_edit_test WHERE id = 1")
            .await
            .expect("read back");
        assert_eq!(check.rows[0][0].as_deref(), Some("O'Brien's edit"));
        eprintln!("update_row round-trip ok: {:?}", check.rows[0][0]);

        // Setting a column to NULL: `value: None` must produce a real NULL,
        // not the literal string "NULL".
        session
            .update_row(
                "public",
                "cubbydb_edit_test",
                &[pk("1")],
                &[ColumnValue {
                    column: "note".into(),
                    value: None,
                }],
            )
            .await
            .expect("update_row setting a column to NULL");
        let nulled = session
            .run_query("SELECT note, note IS NULL AS is_null FROM cubbydb_edit_test WHERE id = 1")
            .await
            .expect("read back nulled column");
        assert_eq!(nulled.rows[0][0], None, "expected an actual SQL NULL");
        assert_eq!(nulled.rows[0][1].as_deref(), Some("t"));
        eprintln!("update_row NULL ok: {:?}", nulled.rows[0][0]);

        // Updating a primary key that doesn't exist must error, not silently
        // no-op or touch the wrong row.
        let no_match = session
            .update_row(
                "public",
                "cubbydb_edit_test",
                &[pk("999")],
                &[ColumnValue {
                    column: "note".into(),
                    value: Some("should not apply".into()),
                }],
            )
            .await
            .expect_err("expected an error for a non-matching primary key");
        eprintln!("zero-match update_row error path ok: {}", no_match.message);

        // --- Pagination: select_top_sql builds LIMIT/OFFSET correctly ---
        let p0 = session.select_top_sql("public", "cubbydb_edit_test", None, 500, 0);
        assert!(p0.contains("LIMIT 500"));
        assert!(!p0.contains("OFFSET"), "page 0 must not add an OFFSET");
        let p1 = session.select_top_sql("public", "cubbydb_edit_test", None, 500, 500);
        assert!(p1.contains("LIMIT 500 OFFSET 500"));
        eprintln!("pagination SQL ok: {p1:?}");

        // If the seeded `widgets` table (1200 rows) is present, page through it.
        if let Ok(page0) = session
            .run_query(&session.select_top_sql("public", "widgets", None, 500, 0))
            .await
        {
            assert_eq!(page0.rows.len(), 500, "first page should be full");
            let page2 = session
                .run_query(&session.select_top_sql("public", "widgets", None, 500, 1000))
                .await
                .expect("third page");
            assert_eq!(page2.rows.len(), 200, "last page should hold the remainder");
            eprintln!(
                "widgets pagination ok: {} + {} rows",
                page0.rows.len(),
                page2.rows.len()
            );
        }

        // --- insert_row / delete_row ---
        session
            .run_query("DROP TABLE IF EXISTS cubbydb_rowops_test")
            .await
            .expect("drop leftover rowops table");
        session
            .run_query(
                "CREATE TABLE cubbydb_rowops_test (id serial PRIMARY KEY, note text, qty int DEFAULT 7)",
            )
            .await
            .expect("create rowops table");

        // A blank draft row becomes INSERT ... DEFAULT VALUES.
        session
            .insert_row("public", "cubbydb_rowops_test", &[])
            .await
            .expect("insert DEFAULT VALUES");
        // An explicit row: a quote in the value, and an explicit NULL column.
        session
            .insert_row(
                "public",
                "cubbydb_rowops_test",
                &[
                    ColumnValue { column: "note".into(), value: Some("O'Hara".into()) },
                    ColumnValue { column: "qty".into(), value: None },
                ],
            )
            .await
            .expect("insert explicit row");
        let after_insert = session
            .run_query("SELECT id, note, qty FROM cubbydb_rowops_test ORDER BY id")
            .await
            .expect("read inserted rows");
        assert_eq!(after_insert.rows.len(), 2);
        // Row 1 took the qty default (7) and a NULL note.
        assert_eq!(after_insert.rows[0][2].as_deref(), Some("7"));
        assert_eq!(after_insert.rows[0][1], None);
        // Row 2 kept its quoted note and an explicit NULL qty.
        assert_eq!(after_insert.rows[1][1].as_deref(), Some("O'Hara"));
        assert_eq!(after_insert.rows[1][2], None);
        eprintln!("insert_row ok: {:?}", after_insert.rows);

        // delete_row removes exactly the keyed row.
        let first_id = after_insert.rows[0][0].clone().expect("serial id");
        session
            .delete_row(
                "public",
                "cubbydb_rowops_test",
                &[ColumnValue { column: "id".into(), value: Some(first_id) }],
            )
            .await
            .expect("delete_row");
        let after_delete = session
            .run_query("SELECT count(*) FROM cubbydb_rowops_test")
            .await
            .expect("count after delete");
        assert_eq!(after_delete.rows[0][0].as_deref(), Some("1"));

        // Deleting a non-existent key errors rather than silently no-oping.
        let del_err = session
            .delete_row(
                "public",
                "cubbydb_rowops_test",
                &[ColumnValue { column: "id".into(), value: Some("999999".into()) }],
            )
            .await
            .expect_err("expected an error deleting a missing row");
        eprintln!("delete_row ok; missing-row error path: {}", del_err.message);

        session
            .run_query("DROP TABLE cubbydb_rowops_test")
            .await
            .expect("clean up rowops table");

        session
            .run_query("DROP TABLE cubbydb_edit_test")
            .await
            .expect("clean up scratch table");
    }

    /// Verifies the specific property that makes cancellation actually work:
    /// a `QueryCanceller` obtained from a session can interrupt a query
    /// that's *currently in flight on that same session* — from a separate
    /// concurrent task, with no shared lock between them. This is the exact
    /// shape `commands::cancel_query` relies on (it only ever touches
    /// `AppState.canceller`, never the `AppState.active` lock that an
    /// in-flight `run_query` holds for its whole duration).
    ///
    ///   CUBBYDB_TEST_DSN="postgresql://user@localhost/db" \
    ///     cargo test --lib -- --ignored --nocapture live_cancel_query
    #[tokio::test]
    #[ignore = "requires a running Postgres (set CUBBYDB_TEST_DSN)"]
    async fn live_cancel_query() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use super::super::{ConnectionParams, DatabaseDriver};

        let Ok(dsn) = std::env::var("CUBBYDB_TEST_DSN") else {
            eprintln!("CUBBYDB_TEST_DSN not set; skipping");
            return;
        };

        let driver = PostgresDriver::new();
        let params = ConnectionParams {
            connection_string: Some(dsn),
            ..Default::default()
        };
        let session: Arc<Box<dyn super::super::DbSession>> =
            Arc::new(driver.connect(&params).await.expect("connect"));

        let canceller = session.canceller();

        let query_session = session.clone();
        let query_task = tokio::spawn(async move {
            let start = Instant::now();
            let result = query_session.run_query("SELECT pg_sleep(15)").await;
            (result, start.elapsed())
        });

        // Give the sleep query time to actually start executing on the server
        // before trying to cancel it.
        tokio::time::sleep(Duration::from_millis(500)).await;

        let cancel_start = Instant::now();
        canceller.cancel().await.expect("cancel_query itself should succeed");
        let cancel_elapsed = cancel_start.elapsed();
        eprintln!("cancel() returned in {cancel_elapsed:?}");
        // The cancel call is its own short connection — it must not be stuck
        // waiting behind the 15s query.
        assert!(
            cancel_elapsed < Duration::from_secs(5),
            "cancel() took {cancel_elapsed:?} — it may have incorrectly blocked \
             on the same lock as the in-flight query"
        );

        let (result, query_elapsed) = query_task.await.expect("query task panicked");
        eprintln!("cancelled query returned in {query_elapsed:?}: {result:?}");
        let err = result.expect_err("the cancelled query should return an error, not succeed");
        // Postgres reports a cancelled statement as SQLSTATE 57014.
        assert_eq!(err.code.as_deref(), Some("57014"), "expected a query_canceled SQLSTATE");
        assert!(
            query_elapsed < Duration::from_secs(10),
            "query returned in {query_elapsed:?} — expected it to be interrupted well \
             before its own 15s pg_sleep would have finished"
        );

        // The session must still be usable afterward — cancelling one query
        // shouldn't poison the connection for the next one.
        let after = session
            .run_query("SELECT 1 AS n")
            .await
            .expect("session should still work after a cancelled query");
        assert_eq!(after.rows[0][0].as_deref(), Some("1"));
        eprintln!("session still usable after cancel: {:?}", after.rows);
    }

    /// Verifies `table_structure` against a scratch table exercising a
    /// default expression, a NOT NULL / nullable pair, a primary key, a
    /// secondary index, and a CHECK constraint.
    ///
    ///   CUBBYDB_TEST_DSN="postgresql://user@localhost/db" \
    ///     cargo test --lib -- --ignored --nocapture live_table_structure
    #[tokio::test]
    #[ignore = "requires a running Postgres (set CUBBYDB_TEST_DSN)"]
    async fn live_table_structure() {
        use super::super::{ConnectionParams, DatabaseDriver};

        let Ok(dsn) = std::env::var("CUBBYDB_TEST_DSN") else {
            eprintln!("CUBBYDB_TEST_DSN not set; skipping");
            return;
        };

        let driver = PostgresDriver::new();
        let params = ConnectionParams {
            connection_string: Some(dsn),
            ..Default::default()
        };
        let session = driver.connect(&params).await.expect("connect");

        session
            .run_query("DROP TABLE IF EXISTS cubbydb_structure_test")
            .await
            .expect("drop leftover structure table");
        session
            .run_query(
                "CREATE TABLE cubbydb_structure_test (
                    id serial PRIMARY KEY,
                    name text NOT NULL,
                    qty int DEFAULT 0 CHECK (qty >= 0),
                    note text
                )",
            )
            .await
            .expect("create structure table");
        session
            .run_query("CREATE INDEX cubbydb_structure_test_name_idx ON cubbydb_structure_test (name)")
            .await
            .expect("create secondary index");

        let structure = session
            .table_structure("public", "cubbydb_structure_test")
            .await
            .expect("table_structure");
        eprintln!("{structure:#?}");

        assert_eq!(structure.columns.len(), 4);
        let by_name = |n: &str| {
            structure
                .columns
                .iter()
                .find(|c| c.name == n)
                .unwrap_or_else(|| panic!("expected a column named {n}"))
        };

        let id = by_name("id");
        assert!(id.is_primary_key, "id should be flagged as the primary key");
        assert!(!id.nullable);
        assert!(
            id.default_expr.as_deref().is_some_and(|d| d.contains("nextval")),
            "serial column should have a nextval() default, got {:?}",
            id.default_expr,
        );

        let name = by_name("name");
        assert!(!name.is_primary_key);
        assert!(!name.nullable, "name is NOT NULL");
        assert_eq!(name.default_expr, None);

        let qty = by_name("qty");
        assert!(qty.nullable, "qty has no NOT NULL, so it's nullable");
        assert_eq!(qty.default_expr.as_deref(), Some("0"));

        let note = by_name("note");
        assert!(note.nullable);
        assert_eq!(note.default_expr, None);

        // The primary key's own index, plus the secondary one we created —
        // pg_indexes should report both with real CREATE INDEX text.
        assert_eq!(structure.indexes.len(), 2);
        let secondary = structure
            .indexes
            .iter()
            .find(|i| i.name == "cubbydb_structure_test_name_idx")
            .expect("expected the secondary index");
        assert!(secondary.definition.to_uppercase().starts_with("CREATE INDEX"));
        assert!(secondary.definition.contains("name"));

        assert_eq!(structure.check_constraints.len(), 1);
        assert!(structure.check_constraints[0].definition.contains("qty"));
        assert!(structure.check_constraints[0].definition.contains(">="));

        session
            .run_query("DROP TABLE cubbydb_structure_test")
            .await
            .expect("clean up structure table");
    }

    /// Live end-to-end test for the delete-impact preview and cascade
    /// delete against a real Postgres, using a genuine two-level FK chain
    /// (`customers` -> `orders` -> `order_items`) — exactly the shape this
    /// feature exists for. Ignored by default; same setup as `live_smoke`.
    #[tokio::test]
    #[ignore = "requires a running Postgres (set CUBBYDB_TEST_DSN)"]
    async fn live_delete_cascade() {
        use super::super::{ConnectionParams, ColumnValue, DatabaseDriver};

        let Ok(dsn) = std::env::var("CUBBYDB_TEST_DSN") else {
            eprintln!("CUBBYDB_TEST_DSN not set; skipping");
            return;
        };

        let driver = PostgresDriver::new();
        let params = ConnectionParams {
            connection_string: Some(dsn),
            ..Default::default()
        };
        let session = driver.connect(&params).await.expect("connect");

        for stmt in [
            "DROP TABLE IF EXISTS cubbydb_cascade_items",
            "DROP TABLE IF EXISTS cubbydb_cascade_orders",
            "DROP TABLE IF EXISTS cubbydb_cascade_customers",
        ] {
            session.run_query(stmt).await.expect("drop leftover cascade tables");
        }
        session
            .run_query("CREATE TABLE cubbydb_cascade_customers (id serial PRIMARY KEY, name text)")
            .await
            .expect("create customers");
        session
            .run_query(
                "CREATE TABLE cubbydb_cascade_orders (
                    id serial PRIMARY KEY,
                    customer_id int NOT NULL REFERENCES cubbydb_cascade_customers(id)
                )",
            )
            .await
            .expect("create orders");
        session
            .run_query(
                "CREATE TABLE cubbydb_cascade_items (
                    id serial PRIMARY KEY,
                    order_id int NOT NULL REFERENCES cubbydb_cascade_orders(id)
                )",
            )
            .await
            .expect("create order_items");

        session
            .run_query("INSERT INTO cubbydb_cascade_customers (id, name) VALUES (1, 'Alice')")
            .await
            .expect("insert customer");
        session
            .run_query("INSERT INTO cubbydb_cascade_orders (id, customer_id) VALUES (10, 1), (11, 1)")
            .await
            .expect("insert orders");
        session
            .run_query(
                "INSERT INTO cubbydb_cascade_items (id, order_id) VALUES (100, 10), (101, 10), (102, 11)",
            )
            .await
            .expect("insert items");

        // Deleting the customer directly should fail today, same as before
        // this feature existed — confirms the scenario is real.
        let direct = session
            .delete_row(
                "public",
                "cubbydb_cascade_customers",
                &[ColumnValue { column: "id".to_string(), value: Some("1".to_string()) }],
            )
            .await;
        assert!(direct.is_err(), "deleting a row with dependents should still fail without cascading");

        let pk = vec![vec![ColumnValue { column: "id".to_string(), value: Some("1".to_string()) }]];
        let impact = session
            .delete_impact("public", "cubbydb_cascade_customers", &pk)
            .await
            .expect("delete_impact");
        eprintln!("{impact:#?}");

        assert!(!impact.incomplete);
        assert_eq!(impact.dependents.len(), 1, "one directly-dependent table: orders");
        let orders = &impact.dependents[0];
        assert_eq!(orders.table, "cubbydb_cascade_orders");
        assert_eq!(orders.total_count, 2);
        assert!(!orders.truncated);
        assert_eq!(orders.children.len(), 1, "one further-dependent table: order_items");
        let items = &orders.children[0];
        assert_eq!(items.table, "cubbydb_cascade_items");
        assert_eq!(items.total_count, 3);

        let deleted = session
            .delete_row_cascade("public", "cubbydb_cascade_customers", &pk)
            .await
            .expect("delete_row_cascade");
        assert_eq!(deleted, 1 + 2 + 3, "1 customer + 2 orders + 3 items");

        let remaining = session
            .run_query("SELECT count(*) FROM cubbydb_cascade_items")
            .await
            .expect("count remaining items");
        assert_eq!(remaining.rows[0][0].as_deref(), Some("0"));

        for stmt in [
            "DROP TABLE cubbydb_cascade_items",
            "DROP TABLE cubbydb_cascade_orders",
            "DROP TABLE cubbydb_cascade_customers",
        ] {
            session.run_query(stmt).await.expect("clean up cascade tables");
        }
    }
}
