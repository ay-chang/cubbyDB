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
    ColumnNode, ConnectionInfo, ConnectionParams, DatabaseDriver, DbError, DbErrorKind, DbSession,
    Engine, ForeignKeyRef, QueryResult, ResultColumn, SchemaNode, TableKind, TableNode,
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
        sql.push_str(&format!("\nLIMIT {limit};"));
        sql
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
        DbError::new(kind, e.to_string())
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
    }
}
