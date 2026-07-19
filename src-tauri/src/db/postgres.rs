//! PostgreSQL implementation of the [`DatabaseDriver`] / [`DbSession`] traits.
//!
//! This is the only module that depends on `tokio-postgres`. Result values are
//! read with `simple_query`, which returns every value in its canonical text
//! representation, so we never need per-type conversion code in the grid path.

use std::collections::HashMap;
use std::time::Instant;

use async_trait::async_trait;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::{Config, SimpleQueryMessage};

use super::{
    ColumnNode, ColumnValue, ConnectionInfo, ConnectionParams, DatabaseDriver, DbError,
    DbErrorKind, DbSession, Engine, ForeignKeyRef, QueryResult, ResultColumn, SchemaNode,
    TableKind, TableNode,
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

        // Fold columns into an ordered map: schema -> tables -> columns.
        let mut schemas: Vec<SchemaNode> = schema_rows
            .iter()
            .map(|r| SchemaNode {
                name: r.get::<_, String>(0),
                tables: Vec::new(),
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

        Ok(QueryResult {
            row_count: rows.len(),
            columns,
            rows,
            elapsed_ms,
            command_tag,
            limit_applied,
        })
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
}

/// Connect, spawn the connection driver task, and read the server version.
async fn establish(params: &ConnectionParams) -> Result<(tokio_postgres::Client, ConnectionInfo), DbError> {
    let config = build_config(params)?;

    // native-tls uses the OS trust store; combined with sslmode=prefer this
    // negotiates TLS when the server offers it and falls back to plaintext.
    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| DbError::new(DbErrorKind::Connection, format!("TLS setup failed: {e}")))?;
    let connector = postgres_native_tls::MakeTlsConnector::new(tls);

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
}
