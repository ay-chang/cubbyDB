//! Tauri command surface — the bridge between the React frontend and the
//! database layer. Commands speak only in the neutral `db` types; no SQL is
//! constructed here or on the frontend (except the user's editor text).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::ai::chats::{AiChatSummary, AiChatThread};
use crate::ai::config::{AiConfigStatus, AiProvider};
use crate::ai::{ActiveTableRef, AiChatResult, ChatMessage, ModelInfo, ReasoningEffort};
use crate::connections::{LastConnection, SavedConnection};
use crate::cubbies::Cubby;
use crate::db::{
    driver_for, schema_diff, ColumnValue, ConnectionInfo, ConnectionParams, DbError, DbErrorKind,
    DeleteImpact, Engine, FunctionDefinition, QueryResult, SchemaCompareResult, SchemaNode,
    SchemaSnapshot, SequenceDetails, TableStructure, PAGE_SIZE,
};
use crate::history::{now_millis, HistoryEntry};
use crate::saved_queries::SavedQuery;
use crate::state::{ActiveSession, AppState};

/// Returned by `connect` for a newly-opened session: its id (used by every
/// other session-scoped command to address it) plus the same info the UI top
/// bar shows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConnectionInfo {
    pub session_id: String,
    pub name: String,
    pub connection_id: Option<String>,
    pub info: ConnectionInfo,
}

/// The active cubby's contribution to an `ai_chat` turn, sent fresh by the
/// frontend on every call — same treatment as `schema` below, which is also
/// resent in full each turn rather than cached server-side. It only actually
/// varies when the user edits the cubby mid-conversation, which is rare
/// enough that `build_system_prompt`'s prefix-caching note doesn't call it
/// out specially.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubbyPromptInfo {
    pub name: String,
    pub tables: Vec<ActiveTableRef>,
}

/// Opaque id for one live session — monotonic-enough for in-memory keys
/// (nanoseconds since the epoch, mirroring `connections::new_id`'s approach
/// for saved-connection ids).
fn new_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("sess_{nanos}")
}

// --- Saved connections -----------------------------------------------------

#[tauri::command]
pub async fn list_saved_connections(
    state: State<'_, AppState>,
) -> Result<Vec<SavedConnection>, DbError> {
    state.connection_store().list()
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    connection: SavedConnection,
) -> Result<SavedConnection, DbError> {
    state.connection_store().upsert(connection)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), DbError> {
    state.connection_store().delete(&id)
}

// --- Saved queries -----------------------------------------------------------

#[tauri::command]
pub async fn list_saved_queries(state: State<'_, AppState>) -> Result<Vec<SavedQuery>, DbError> {
    state.saved_query_store().list()
}

#[tauri::command]
pub async fn save_query(
    state: State<'_, AppState>,
    query: SavedQuery,
) -> Result<SavedQuery, DbError> {
    state.saved_query_store().upsert(query)
}

#[tauri::command]
pub async fn delete_saved_query(state: State<'_, AppState>, id: String) -> Result<(), DbError> {
    state.saved_query_store().delete(&id)
}

// --- Cubbies -----------------------------------------------------------------

#[tauri::command]
pub async fn list_cubbies(state: State<'_, AppState>) -> Result<Vec<Cubby>, DbError> {
    state.cubby_store().list()
}

#[tauri::command]
pub async fn save_cubby(state: State<'_, AppState>, cubby: Cubby) -> Result<Cubby, DbError> {
    state.cubby_store().upsert(cubby)
}

#[tauri::command]
pub async fn delete_cubby(state: State<'_, AppState>, id: String) -> Result<(), DbError> {
    state.cubby_store().delete(&id)
}

// --- Connect / test --------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    params: ConnectionParams,
    engine: Option<Engine>,
) -> Result<ConnectionInfo, DbError> {
    let driver = driver_for(engine.unwrap_or_default());
    driver.test_connection(&params, state.data_dir()).await
}

/// Whether an SSH bastion's host key is safe to proceed with, from the
/// trust-on-first-use store.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SshHostKeyStatus {
    /// Never seen before — the frontend should show the fingerprint and ask
    /// for confirmation before this bastion is used for a real tunnel.
    Unknown,
    /// Matches what was previously confirmed; safe to proceed silently.
    Trusted,
    /// Seen before, but the key is now different — the frontend should
    /// treat this as a hard stop (a reconfigured bastion, or a possible
    /// man-in-the-middle) rather than a routine reprompt.
    Changed { previous_fingerprint: String },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyProbe {
    pub fingerprint: String,
    pub key_type: String,
    pub status: SshHostKeyStatus,
}

/// Reads an SSH bastion's host key without authenticating, and reports
/// whether it's already trusted — the SSH tunnel form calls this as the
/// user fills in the bastion host/port, so trust can be confirmed (or a
/// changed key caught) before a real `connect`/`test_connection` attempt
/// ever opens a tunnel.
#[tauri::command]
pub async fn probe_ssh_host_key(
    state: State<'_, AppState>,
    bastion_host: String,
    bastion_port: u16,
) -> Result<SshHostKeyProbe, DbError> {
    let probed = crate::db::ssh_tunnel::probe_host_key(&bastion_host, bastion_port).await?;
    let trusted = state
        .ssh_known_hosts_store()
        .lookup(&bastion_host, bastion_port)?;
    let status = match trusted {
        None => SshHostKeyStatus::Unknown,
        Some(t) if t.key_fingerprint == probed.fingerprint => SshHostKeyStatus::Trusted,
        Some(t) => SshHostKeyStatus::Changed {
            previous_fingerprint: t.key_fingerprint,
        },
    };
    Ok(SshHostKeyProbe {
        fingerprint: probed.fingerprint,
        key_type: probed.key_type,
        status,
    })
}

/// Records `fingerprint` as trusted for this bastion — called only after
/// the frontend's own confirmation UI, never automatically. The actual
/// tunnel-opening path (`ssh_tunnel::open_tunnel`'s `TofuHandler`) only ever
/// *reads* this store, so a key can't become trusted any other way.
#[tauri::command]
pub async fn trust_ssh_host_key(
    state: State<'_, AppState>,
    bastion_host: String,
    bastion_port: u16,
    fingerprint: String,
) -> Result<(), DbError> {
    state
        .ssh_known_hosts_store()
        .trust(&bastion_host, bastion_port, &fingerprint)
}

/// Open a new session and add it to the pool — never overwrites an existing
/// one, so connecting to a second database leaves the first live.
///
/// `remember_as_last` defaults to `true` (persist this as the connection to
/// auto-reconnect to next launch). The one exception is launch's own
/// auto-reconnect: it just *read* this exact connection from the last-used
/// file to get here, so writing the identical record straight back would be
/// a pure, avoidable disk write.
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    params: ConnectionParams,
    name: String,
    engine: Option<Engine>,
    connection_id: Option<String>,
    remember_as_last: Option<bool>,
) -> Result<ActiveConnectionInfo, DbError> {
    let engine = engine.unwrap_or_default();
    let driver = driver_for(engine);
    let session = driver.connect(&params, state.data_dir()).await?;
    let info = session.info().clone();

    if remember_as_last.unwrap_or(true) {
        // Remember this connection so the next launch can reconnect automatically.
        if let Err(e) = state.last_connection_store().set(&LastConnection {
            name: name.clone(),
            engine,
            params: params.clone(),
            id: connection_id.clone(),
        }) {
            eprintln!("[cubbydb] failed to persist last connection: {e}");
        }
    }

    let session_id = new_session_id();
    state
        .canceller
        .lock()
        .await
        .insert(session_id.clone(), session.canceller());

    state.active.lock().await.insert(
        session_id.clone(),
        ActiveSession {
            session,
            name: name.clone(),
            connection_id: connection_id.clone(),
            params,
            engine,
        },
    );

    Ok(ActiveConnectionInfo {
        session_id,
        name,
        connection_id,
        info,
    })
}

/// Re-establish an *existing* session at `session_id` with edited
/// params/name — used when the user edits "the connection I'm currently on"
/// (connection string, name, ...) and wants it applied right away, rather
/// than only saved for next time. Keeps the same session id (so the
/// frontend's tabs/schema for that slot aren't lost), unlike `connect`,
/// which always allocates a fresh one. Errors if `session_id` isn't a
/// currently-open session — this edits an existing connection, not create
/// one out of nowhere.
#[tauri::command]
pub async fn reconnect_session(
    state: State<'_, AppState>,
    session_id: String,
    params: ConnectionParams,
    name: String,
    engine: Option<Engine>,
    connection_id: Option<String>,
) -> Result<ActiveConnectionInfo, DbError> {
    if !state.active.lock().await.contains_key(&session_id) {
        return Err(DbError::not_connected());
    }

    let engine = engine.unwrap_or_default();
    let driver = driver_for(engine);
    let session = driver.connect(&params, state.data_dir()).await?;
    let info = session.info().clone();

    if let Err(e) = state.last_connection_store().set(&LastConnection {
        name: name.clone(),
        engine,
        params: params.clone(),
        id: connection_id.clone(),
    }) {
        eprintln!("[cubbydb] failed to persist last connection: {e}");
    }

    state
        .canceller
        .lock()
        .await
        .insert(session_id.clone(), session.canceller());

    state.active.lock().await.insert(
        session_id.clone(),
        ActiveSession {
            session,
            name: name.clone(),
            connection_id: connection_id.clone(),
            params,
            engine,
        },
    );

    Ok(ActiveConnectionInfo {
        session_id,
        name,
        connection_id,
        info,
    })
}

/// Re-establish a dropped session in place, reusing its stored parameters, and
/// refresh its `state.canceller` entry to match the new session. Returns an
/// error if there was no session at `session_id` to reconnect.
async fn reconnect_in_place(
    active: &mut HashMap<String, ActiveSession>,
    session_id: &str,
    state: &AppState,
) -> Result<(), DbError> {
    let old = active.get(session_id).ok_or_else(DbError::not_connected)?;
    let params = old.params.clone();
    let engine = old.engine;
    let name = old.name.clone();
    let connection_id = old.connection_id.clone();

    let session = driver_for(engine).connect(&params, state.data_dir()).await?;
    state
        .canceller
        .lock()
        .await
        .insert(session_id.to_string(), session.canceller());
    active.insert(
        session_id.to_string(),
        ActiveSession {
            session,
            name,
            connection_id,
            params,
            engine,
        },
    );
    Ok(())
}

/// `schema_snapshot`, with the same try-once/reconnect-once-on-`Connection`-
/// error shape every other session command uses — factored out here (rather
/// than inlined like `get_table_structure`'s single-session version) because
/// `compare_schemas` needs it twice, against two independent session ids.
async fn snapshot_with_retry(
    active: &mut HashMap<String, ActiveSession>,
    session_id: &str,
    schema: &str,
    state: &AppState,
) -> Result<SchemaSnapshot, DbError> {
    {
        let session = active.get(session_id).ok_or_else(DbError::not_connected)?;
        match session.session.schema_snapshot(schema).await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(active, session_id, state).await?;
    active
        .get(session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .schema_snapshot(schema)
        .await
}

/// Refuses a mutation outright on a connection marked read-only
/// (`ConnectionParams::read_only`), before it ever reaches the database.
/// Unlike `run_query`'s read-only path — which still runs a SELECT inside a
/// rolled-back transaction, since the statement might be one — these
/// commands each build a specific INSERT/UPDATE/DELETE themselves, so
/// there's no ambiguity to preserve: always reject.
fn ensure_writable(session: &ActiveSession) -> Result<(), DbError> {
    if session.params.read_only {
        return Err(DbError::internal(
            "This connection is read-only — writes are disabled.",
        ));
    }
    Ok(())
}

/// Flips the read-only guard on an already-connected session in place — no
/// reconnect, no new database round trip. Unlike a host/port/credential
/// change (which genuinely needs a fresh connection to take effect),
/// read-only is purely a policy this app enforces on top of an existing
/// connection, so there's nothing to re-establish; only `params.read_only`,
/// read by `ensure_writable` and `run_query`'s read-only branch, needs to
/// change. Mirrors `setConnectionColor`'s "applies immediately on Update,
/// no separate Reconnect" precedent on the frontend — see
/// `ConnectionScreen.tsx`'s `handleSave`.
#[tauri::command]
pub async fn set_session_read_only(
    state: State<'_, AppState>,
    session_id: String,
    read_only: bool,
) -> Result<(), DbError> {
    let mut active = state.active.lock().await;
    let session = active.get_mut(&session_id).ok_or_else(DbError::not_connected)?;
    session.params.read_only = read_only;
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), DbError> {
    state.active.lock().await.remove(&session_id);
    state.canceller.lock().await.remove(&session_id);
    // An explicit disconnect opts out of launch auto-reconnect only once every
    // connection is closed — a still-live connection should keep being the
    // auto-reconnect target rather than losing it because a *different*
    // session was disconnected.
    if state.active.lock().await.is_empty() {
        if let Err(e) = state.last_connection_store().clear() {
            eprintln!("[cubbydb] failed to clear last connection: {e}");
        }
    }
    Ok(())
}

/// Ask the server to interrupt whatever this session is currently running.
/// Deliberately reads only `state.canceller` — never `state.active`, which an
/// in-flight `run_query` holds locked for its whole duration; using that lock
/// here would make a cancel request queue up behind the very query it's meant
/// to interrupt. If nothing is running (or the session id is unknown), this
/// is a harmless no-op.
#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, session_id: String) -> Result<(), DbError> {
    match state.canceller.lock().await.get(&session_id) {
        Some(canceller) => canceller.cancel().await,
        None => Ok(()),
    }
}

/// The last connection's parameters, for auto-reconnect on launch.
#[tauri::command]
pub async fn get_last_connection(
    state: State<'_, AppState>,
) -> Result<Option<LastConnection>, DbError> {
    state.last_connection_store().get()
}

// --- Schema / query --------------------------------------------------------

#[tauri::command]
pub async fn fetch_schema(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<SchemaNode>, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        match session.session.fetch_schema().await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    // The connection had dropped — reconnect once and try again.
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .fetch_schema()
        .await
}

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    // Zero-based page of the result; omitted means the first page.
    page: Option<u32>,
) -> Result<QueryResult, DbError> {
    let page = page.unwrap_or(0);
    let mut active = state.active.lock().await;
    let connection_name = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .name
        .clone();
    let read_only = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .params
        .read_only;

    let mut result = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .run_query(&sql, page, read_only)
        .await;

    // If the connection had silently dropped, reconnect once and retry.
    if matches!(&result, Err(e) if e.kind == DbErrorKind::Connection) {
        if let Ok(()) = reconnect_in_place(&mut active, &session_id, &state).await {
            if let Some(session) = active.get(&session_id) {
                result = session.session.run_query(&sql, page, read_only).await;
            }
        }
    }

    // Best-effort history logging — a failed write must not fail the query.
    let entry = match &result {
        Ok(r) => HistoryEntry {
            sql: sql.clone(),
            connection_name: Some(connection_name),
            executed_at: now_millis(),
            success: true,
            row_count: Some(r.row_count),
            elapsed_ms: Some(r.elapsed_ms),
            error: None,
        },
        Err(e) => HistoryEntry {
            sql: sql.clone(),
            connection_name: Some(connection_name),
            executed_at: now_millis(),
            success: false,
            row_count: None,
            elapsed_ms: None,
            error: Some(e.message.clone()),
        },
    };
    if let Err(log_err) = state.history_store().append(&entry) {
        eprintln!("[cubbydb] failed to write query history: {log_err}");
    }

    result
}

/// Generate the "Select top N" SQL for a table. Returned to the frontend so it
/// can open a new editor tab pre-filled with it — the SQL originates here.
#[tauri::command]
pub async fn select_top_sql(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    sort_column: Option<String>,
    sort_desc: Option<bool>,
) -> Result<String, DbError> {
    let active = state.active.lock().await;
    let active = active.get(&session_id).ok_or_else(DbError::not_connected)?;
    Ok(active.session.select_top_sql(
        &schema,
        &table,
        filter.as_deref(),
        limit.unwrap_or(PAGE_SIZE),
        offset.unwrap_or(0),
        sort_column
            .as_deref()
            .map(|c| (c, sort_desc.unwrap_or(false))),
    ))
}

/// Apply one row's pending edits as a primary-key-scoped `UPDATE`. Called once
/// per edited row when the grid's "Update" action is committed.
#[tauri::command]
pub async fn update_row(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_key: Vec<ColumnValue>,
    changes: Vec<ColumnValue>,
) -> Result<(), DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        ensure_writable(session)?;
        match session
            .session
            .update_row(&schema, &table, &primary_key, &changes)
            .await
        {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .update_row(&schema, &table, &primary_key, &changes)
        .await
}

/// Insert one new row (a committed draft row from the grid).
#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    values: Vec<ColumnValue>,
) -> Result<(), DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        ensure_writable(session)?;
        match session.session.insert_row(&schema, &table, &values).await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .insert_row(&schema, &table, &values)
        .await
}

/// Delete one row by its primary key (the grid's "Remove row" action).
#[tauri::command]
pub async fn delete_row(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_key: Vec<ColumnValue>,
) -> Result<(), DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        ensure_writable(session)?;
        match session
            .session
            .delete_row(&schema, &table, &primary_key)
            .await
        {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .delete_row(&schema, &table, &primary_key)
        .await
}

/// Read-only preview of what deleting `primary_keys` would cascade into —
/// every row in other tables that references one of them, walked
/// transitively. Shown before a delete that would otherwise just fail with a
/// raw FK-violation error.
#[tauri::command]
pub async fn get_delete_impact(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_keys: Vec<Vec<ColumnValue>>,
) -> Result<DeleteImpact, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        match session
            .session
            .delete_impact(&schema, &table, &primary_keys)
            .await
        {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .delete_impact(&schema, &table, &primary_keys)
        .await
}

/// Deletes `primary_keys` and everything `get_delete_impact` would report
/// for them, in one transaction. Returns the total number of rows deleted.
#[tauri::command]
pub async fn delete_rows_cascade(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_keys: Vec<Vec<ColumnValue>>,
) -> Result<u64, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        ensure_writable(session)?;
        match session
            .session
            .delete_row_cascade(&schema, &table, &primary_keys)
            .await
        {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .delete_row_cascade(&schema, &table, &primary_keys)
        .await
}

/// Column, index, and check-constraint details for one table — the "View
/// structure" panel.
#[tauri::command]
pub async fn get_table_structure(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Result<TableStructure, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        match session.session.table_structure(&schema, &table).await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .table_structure(&schema, &table)
        .await
}

/// Diffs one schema against another — possibly on a different open
/// connection entirely — and generates a best-effort migration script.
/// Read-only: this only ever reads catalog metadata and never executes
/// anything itself; see `schema_diff::generate_migration_sql`'s doc comment
/// for why the generated SQL's statement ordering is best-effort, not
/// guaranteed-valid SQL. The two snapshot lookups run sequentially against
/// the same lock guard (never concurrently), which also makes comparing two
/// schemas on the *same* connection (`source_session_id == target_session_id`)
/// work with no double-borrow issue.
#[tauri::command]
pub async fn compare_schemas(
    state: State<'_, AppState>,
    source_session_id: String,
    source_schema: String,
    target_session_id: String,
    target_schema: String,
) -> Result<SchemaCompareResult, DbError> {
    let mut active = state.active.lock().await;
    let source =
        snapshot_with_retry(&mut active, &source_session_id, &source_schema, &state).await?;
    let target =
        snapshot_with_retry(&mut active, &target_session_id, &target_schema, &state).await?;
    drop(active);

    let diff = schema_diff::diff_snapshots(&source, &target);
    let migration = schema_diff::generate_migration_sql(&source_schema, &target_schema, &diff);
    Ok(SchemaCompareResult { diff, migration })
}

/// A function/procedure's full body, by oid — the schema tree's "View
/// definition" context-menu action.
#[tauri::command]
pub async fn get_function_definition(
    state: State<'_, AppState>,
    session_id: String,
    oid: i64,
) -> Result<FunctionDefinition, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        match session.session.function_definition(oid).await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .function_definition(oid)
        .await
}

/// One sequence's current value and configuration — the schema tree's "View
/// details" context-menu action.
#[tauri::command]
pub async fn get_sequence_details(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    name: String,
) -> Result<SequenceDetails, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
        match session.session.sequence_details(&schema, &name).await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    reconnect_in_place(&mut active, &session_id, &state).await?;
    active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .sequence_details(&schema, &name)
        .await
}

// --- Clipboard --------------------------------------------------------------
// The results grid copies/pastes through the OS clipboard here rather than the
// webview's `navigator.clipboard`, which isn't reliably granted inside the
// Tauri window.

/// Write an exported file to a path the user just picked in the native save
/// dialog. The path is only ever one the OS dialog handed back, so this does
/// no scoping of its own — it exists so the export doesn't have to pull in
/// the filesystem plugin for a single write.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), DbError> {
    std::fs::write(&path, contents)
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Could not save {path}: {e}")))
}

/// Reads a file's contents as text — the counterpart to `write_text_file`,
/// used by the SSH tunnel form's "Browse…" private-key picker. The picked
/// *contents* end up in the saved connection, not this path (see
/// `SshAuthMethod::PrivateKey`'s own doc comment for why); this command's
/// only job is getting them off disk once, right after the user picks the
/// file.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, DbError> {
    std::fs::read_to_string(&path)
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Could not read {path}: {e}")))
}

#[tauri::command]
pub async fn write_clipboard(text: String) -> Result<(), DbError> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Clipboard unavailable: {e}")))?;
    clipboard
        .set_text(text)
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Copy failed: {e}")))
}

#[tauri::command]
pub async fn read_clipboard() -> Result<String, DbError> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| DbError::new(DbErrorKind::Internal, format!("Clipboard unavailable: {e}")))?;
    // An empty clipboard (or non-text content) reads as empty text, not an error.
    Ok(clipboard.get_text().unwrap_or_default())
}

#[tauri::command]
pub async fn query_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, DbError> {
    state.history_store().recent(limit.unwrap_or(200))
}

#[tauri::command]
pub async fn clear_query_history(state: State<'_, AppState>) -> Result<(), DbError> {
    state.history_store().clear()
}

// --- AI assistant ------------------------------------------------------------

#[tauri::command]
pub async fn get_ai_config(state: State<'_, AppState>) -> Result<AiConfigStatus, DbError> {
    let config = state.ai_config_store().get()?;
    Ok(ai_config_status(state.inner(), &config).await)
}

async fn ai_config_status(
    state: &AppState,
    config: &crate::ai::config::AiConfig,
) -> AiConfigStatus {
    let mut status: AiConfigStatus = config.into();
    if config.provider() == AiProvider::Codex {
        let codex = crate::ai::codex::status(state.data_dir()).await;
        status.codex_installed = codex.installed;
        status.codex_authenticated = codex.authenticated;
        status.codex_email = codex.email;
        status.codex_plan_type = codex.plan_type;
        status.codex_version = codex.version;
        status.codex_error = codex.error;
    }
    if config.provider() == AiProvider::ClaudeCode {
        let claude_code = crate::ai::claude_code::status().await;
        status.claude_code_installed = claude_code.installed;
        status.claude_code_authenticated = claude_code.authenticated;
        status.claude_code_email = claude_code.email;
        status.claude_code_plan_type = claude_code.plan_type;
        status.claude_code_version = claude_code.version;
        status.claude_code_error = claude_code.error;
    }
    status
}

/// Selects which configured provider handles new assistant turns.
#[tauri::command]
pub async fn save_ai_provider(
    state: State<'_, AppState>,
    provider: AiProvider,
) -> Result<AiConfigStatus, DbError> {
    let config = state.ai_config_store().set_provider(provider)?;
    Ok(ai_config_status(state.inner(), &config).await)
}

/// Saves a provider API key without returning the secret to the frontend.
#[tauri::command]
pub async fn save_ai_config(
    state: State<'_, AppState>,
    provider: AiProvider,
    api_key: String,
) -> Result<AiConfigStatus, DbError> {
    let config = state.ai_config_store().set_api_key(provider, api_key)?;
    Ok(ai_config_status(state.inner(), &config).await)
}

#[tauri::command]
pub async fn clear_ai_config(
    state: State<'_, AppState>,
    provider: AiProvider,
) -> Result<AiConfigStatus, DbError> {
    let config = state.ai_config_store().clear_api_key(provider)?;
    Ok(ai_config_status(state.inner(), &config).await)
}

#[tauri::command]
pub async fn save_ai_model(
    state: State<'_, AppState>,
    provider: AiProvider,
    model: String,
    supports_effort: bool,
) -> Result<AiConfigStatus, DbError> {
    let config = state
        .ai_config_store()
        .set_model(provider, model, supports_effort)?;
    Ok(ai_config_status(state.inner(), &config).await)
}

#[tauri::command]
pub async fn save_ai_reasoning_effort(
    state: State<'_, AppState>,
    provider: AiProvider,
    effort: ReasoningEffort,
) -> Result<AiConfigStatus, DbError> {
    let config = state
        .ai_config_store()
        .set_reasoning_effort(provider, effort)?;
    Ok(ai_config_status(state.inner(), &config).await)
}

/// Records acceptance of the AI-provider terms at cubbydb.com/terms — the
/// frontend calls this immediately before starting a Codex or Claude Code
/// sign-in the user hasn't already accepted, so connecting a subscription
/// provider always has an explicit, persisted "I accept" behind it.
#[tauri::command]
pub async fn accept_ai_terms(state: State<'_, AppState>) -> Result<AiConfigStatus, DbError> {
    let config = state.ai_config_store().accept_terms()?;
    Ok(ai_config_status(state.inner(), &config).await)
}

/// Starts the Codex CLI's official ChatGPT OAuth flow. Codex owns the browser
/// callback and credential storage; CubbyDB receives no token.
#[tauri::command]
pub async fn start_codex_login(state: State<'_, AppState>) -> Result<(), DbError> {
    crate::ai::codex::start_login(state.data_dir()).await
}

/// Starts Claude Code CLI's own OAuth login flow. Claude Code owns the
/// browser callback and credential storage; CubbyDB receives no token.
#[tauri::command]
pub async fn start_claude_code_login() -> Result<(), DbError> {
    crate::ai::claude_code::start_login().await
}

/// Signs out of the Codex CLI's current ChatGPT account.
#[tauri::command]
pub async fn logout_codex(state: State<'_, AppState>) -> Result<(), DbError> {
    crate::ai::codex::logout(state.data_dir()).await
}

/// Signs out of the Claude Code CLI's current Claude account.
#[tauri::command]
pub async fn logout_claude_code() -> Result<(), DbError> {
    crate::ai::claude_code::logout().await
}

/// Live-fetches the models the saved API key currently has access to, for
/// the Settings model picker. Errors if no key is saved yet.
#[tauri::command]
pub async fn list_ai_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, DbError> {
    let config = state.ai_config_store().get()?;
    match config.provider() {
        AiProvider::Anthropic => {
            let api_key = config
                .api_key()
                .ok_or_else(|| DbError::new(DbErrorKind::Internal, "Save an API key first."))?;
            crate::ai::provider::list_models(api_key).await
        }
        AiProvider::Openai => {
            let api_key = config
                .api_key()
                .ok_or_else(|| DbError::new(DbErrorKind::Internal, "Save an API key first."))?;
            crate::ai::openai::list_models(api_key).await
        }
        AiProvider::Codex => crate::ai::codex::list_models(state.data_dir()).await,
        AiProvider::ClaudeCode => Ok(crate::ai::claude_code::list_models()),
    }
}

/// Re-run a statement the assistant already ran, to export its full result.
///
/// The panel only renders a short preview of a large result, so the Download
/// CSV button has to fetch the whole thing rather than scrape the rows on
/// screen. This deliberately goes through `run_read_only_query` — the same
/// allowlisted, always-rolled-back path the AI's own tools use — and not
/// `run_query`: the SQL originates from the model, so it must keep the same
/// guarantees on the way back out as it had going in.
#[tauri::command]
pub async fn run_readonly_query(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Result<QueryResult, DbError> {
    let mut active = state.active.lock().await;

    let result = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .run_read_only_query(&sql, None)
        .await;

    // Same reconnect-once-on-drop behavior as every other session command.
    if matches!(&result, Err(e) if e.kind == DbErrorKind::Connection) {
        if let Ok(()) = reconnect_in_place(&mut active, &session_id, &state).await {
            if let Some(session) = active.get(&session_id) {
                return session.session.run_read_only_query(&sql, None).await;
            }
        }
    }
    result
}

/// Builds the tool-runner closure the provider loops call, for whichever AI
/// entry point is running: the chat panel (`ai_chat`) or the filter bar
/// (`ai_generate_filter`).
///
/// Session *lifecycle* lives here rather than in `ai::tools`: this closure
/// owns the lock and the reconnect-on-drop retry every other session-scoped
/// command uses, and hands the tools an already-known-good session.
///
/// The returned future is boxed because a closure cannot name an anonymous
/// `async` block's type in its own return position — the alternative is
/// duplicating the whole body at both call sites, which is how the
/// reconnect retry would drift out of sync between them.
fn tool_runner<'a>(
    app_state: &'a AppState,
    session_id: String,
    schema: &'a [SchemaNode],
) -> impl Fn(
    String,
    serde_json::Value,
) -> Pin<Box<dyn Future<Output = Result<crate::ai::tools::ToolOutcome, DbError>> + Send + 'a>>
       + 'a {
    move |name: String, input: serde_json::Value| {
        let session_id = session_id.clone();
        Box::pin(async move {
            let mut active = app_state.active.lock().await;
            {
                let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
                let ctx = crate::ai::tools::ToolContext::new(session.session.as_ref(), schema);
                match crate::ai::tools::execute(&ctx, &name, &input).await {
                    Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
                    other => return other,
                }
            }
            reconnect_in_place(&mut active, &session_id, app_state).await?;
            let session = active.get(&session_id).ok_or_else(DbError::not_connected)?;
            let ctx = crate::ai::tools::ToolContext::new(session.session.as_ref(), schema);
            crate::ai::tools::execute(&ctx, &name, &input).await
        })
    }
}

/// Runs one turn against whichever provider is configured, with whatever
/// system prompt the caller built. Everything provider-shaped — resolving the
/// API key, the model, and the reasoning effort — is settled here so a new
/// AI entry point only has to supply a prompt and a message.
async fn run_provider_turn<F, Fut>(
    state: &AppState,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    run_tool: F,
) -> Result<AiChatResult, DbError>
where
    F: Fn(String, serde_json::Value) -> Fut,
    Fut: std::future::Future<Output = Result<crate::ai::tools::ToolOutcome, DbError>>,
{
    let config = state.ai_config_store().get()?;
    let provider = config.provider();
    let api_key = if matches!(provider, AiProvider::Codex | AiProvider::ClaudeCode) {
        None
    } else {
        Some(config.api_key().ok_or_else(|| {
            let provider_name = match provider {
                AiProvider::Anthropic => "Anthropic",
                AiProvider::Openai => "OpenAI",
                AiProvider::Codex | AiProvider::ClaudeCode => unreachable!(),
            };
            DbError::new(
                DbErrorKind::Internal,
                format!(
                    "No {provider_name} API key configured. Add one in Settings \u{2192} AI Assistant."
                ),
            )
        })?.to_string())
    };

    let model = config.model();
    let send_effort = config.model_supports_effort();
    let reasoning_effort = config.reasoning_effort();
    match provider {
        AiProvider::Anthropic => {
            crate::ai::provider::run_loop(
                api_key.as_deref().unwrap_or_default(),
                model,
                send_effort,
                system_prompt,
                messages,
                run_tool,
            )
            .await
        }
        AiProvider::Openai => {
            crate::ai::openai::run_loop(
                api_key.as_deref().unwrap_or_default(),
                model,
                send_effort.then_some(reasoning_effort.unwrap_or_default()),
                system_prompt,
                messages,
                run_tool,
            )
            .await
        }
        AiProvider::Codex => {
            crate::ai::codex::run_loop(
                state.data_dir(),
                model,
                reasoning_effort.unwrap_or_default(),
                system_prompt,
                messages,
                run_tool,
            )
            .await
        }
        AiProvider::ClaudeCode => {
            crate::ai::claude_code::run_loop(
                state.data_dir(),
                model,
                reasoning_effort.unwrap_or_default(),
                system_prompt,
                messages,
                run_tool,
            )
            .await
        }
    }
}

/// Server version and connection name from the live session, so a prompt can
/// state what the model is actually talking to. Read and released before the
/// tool-call closure takes the same lock.
async fn session_prompt_context(
    state: &AppState,
    session_id: &str,
) -> Result<(String, String), DbError> {
    let active = state.active.lock().await;
    let session = active.get(session_id).ok_or_else(DbError::not_connected)?;
    Ok((
        session.session.info().server_version.clone(),
        session.name.clone(),
    ))
}

/// One AI turn: builds the schema-aware system prompt from the schema tree
/// the frontend already has (no need to re-fetch it here), then runs
/// the selected provider's tool-call loop, executing requested SQL read-only against
/// this session's live connection (see `db::DbSession::run_read_only_query`)
/// with the same reconnect-on-drop retry every other session-scoped command
/// uses.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    session_id: String,
    schema: Vec<SchemaNode>,
    active_table: Option<ActiveTableRef>,
    cubby: Option<CubbyPromptInfo>,
    messages: Vec<ChatMessage>,
) -> Result<AiChatResult, DbError> {
    let (server_version, connection_name) =
        session_prompt_context(state.inner(), &session_id).await?;

    let cubby_tables: Vec<(String, String)> = cubby
        .as_ref()
        .map(|c| c.tables.iter().map(|t| (t.schema.clone(), t.table.clone())).collect())
        .unwrap_or_default();
    let system_prompt = crate::ai::prompt::build_system_prompt(&crate::ai::prompt::PromptContext {
        schema: &schema,
        active_table: active_table
            .as_ref()
            .map(|t| (t.schema.as_str(), t.table.as_str())),
        server_version: &server_version,
        connection_name: &connection_name,
        cubby: cubby.as_ref().map(|c| crate::ai::prompt::CubbyContext {
            name: &c.name,
            tables: &cubby_tables,
        }),
    });

    // A plain `&AppState` (trivially `Copy`, unlike `State` itself) so the
    // tool runner can be called on every loop iteration without needing
    // `state` to implement anything beyond what a shared reference gives us.
    let app_state: &AppState = state.inner();
    let run_tool = tool_runner(app_state, session_id, &schema);
    run_provider_turn(app_state, system_prompt, messages, run_tool).await
}

/// Natural language -> a WHERE predicate for the table browser's filter bar.
///
/// The same providers, key, model, and read-only tools as `ai_chat` — only
/// the system prompt differs (see `ai::filter`), and the reply is parsed back
/// into a bare predicate instead of being shown as prose. Stateless: each
/// request carries its own description and whatever is currently in the bar,
/// so there is no conversation to resume and nothing persisted.
#[tauri::command]
pub async fn ai_generate_filter(
    state: State<'_, AppState>,
    session_id: String,
    schema: Vec<SchemaNode>,
    table: ActiveTableRef,
    prompt: String,
    current_filter: Option<String>,
) -> Result<crate::ai::filter::AiFilterResult, DbError> {
    let description = prompt.trim();
    if description.is_empty() {
        return Err(DbError::new(
            DbErrorKind::Internal,
            "Describe the rows you want first.",
        ));
    }

    let (server_version, _connection_name) =
        session_prompt_context(state.inner(), &session_id).await?;

    let system_prompt = crate::ai::filter::build_filter_prompt(&crate::ai::filter::FilterPromptContext {
        schema: &schema,
        table: (table.schema.as_str(), table.table.as_str()),
        server_version: &server_version,
        current_filter: current_filter.as_deref(),
    });

    let app_state: &AppState = state.inner();
    let run_tool = tool_runner(app_state, session_id, &schema);
    let result = run_provider_turn(
        app_state,
        system_prompt,
        vec![ChatMessage {
            role: "user".to_string(),
            content: description.to_string(),
            trace: None,
        }],
        run_tool,
    )
    .await?;

    Ok(crate::ai::filter::parse_reply(&result.reply))
}

// --- Saved AI chats -----------------------------------------------------------
// Scoped by `connection_id` (a *saved* connection's stable id) rather than a
// `session_id` — a chat only makes sense against the specific database it
// was asked about, and `session_id` is regenerated every reconnect, so it
// can't identify "the same database" across a restart. Ad-hoc connections
// have no `connection_id` and so simply have no entries here; the frontend
// skips calling these for them and keeps today's ephemeral-only behavior.

#[tauri::command]
pub async fn list_ai_chats(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<AiChatSummary>, DbError> {
    state.ai_chat_store().list_for_connection(&connection_id)
}

#[tauri::command]
pub async fn get_ai_chat(state: State<'_, AppState>, id: String) -> Result<AiChatThread, DbError> {
    state
        .ai_chat_store()
        .get(&id)?
        .ok_or_else(|| DbError::new(DbErrorKind::Internal, "Chat not found."))
}

/// Creates (`thread.id` empty) or updates (`thread.id` set) a saved chat.
/// Called after every AI turn for a connection that has a stable id — see
/// `AiChatStore::upsert` for the title-preservation rule that lets callers
/// always pass `title: ""` here except when actually renaming.
#[tauri::command]
pub async fn upsert_ai_chat(
    state: State<'_, AppState>,
    thread: AiChatThread,
) -> Result<AiChatThread, DbError> {
    state.ai_chat_store().upsert(thread)
}

#[tauri::command]
pub async fn rename_ai_chat(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<AiChatSummary, DbError> {
    state.ai_chat_store().rename(&id, title)
}

#[tauri::command]
pub async fn delete_ai_chat(state: State<'_, AppState>, id: String) -> Result<(), DbError> {
    state.ai_chat_store().delete(&id)
}
