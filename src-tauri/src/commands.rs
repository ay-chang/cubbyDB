//! Tauri command surface — the bridge between the React frontend and the
//! database layer. Commands speak only in the neutral `db` types; no SQL is
//! constructed here or on the frontend (except the user's editor text).

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::connections::{LastConnection, SavedConnection};
use crate::db::{
    driver_for, ColumnValue, ConnectionInfo, ConnectionParams, DbError, DbErrorKind, DeleteImpact,
    Engine, FunctionDefinition, QueryResult, SchemaNode, SequenceDetails, TableStructure,
    DEFAULT_ROW_LIMIT,
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

// --- Connect / test --------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    params: ConnectionParams,
    engine: Option<Engine>,
) -> Result<ConnectionInfo, DbError> {
    let driver = driver_for(engine.unwrap_or_default());
    driver.test_connection(&params).await
}

/// Open a new session and add it to the pool — never overwrites an existing
/// one, so connecting to a second database leaves the first live.
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    params: ConnectionParams,
    name: String,
    engine: Option<Engine>,
    connection_id: Option<String>,
) -> Result<ActiveConnectionInfo, DbError> {
    let engine = engine.unwrap_or_default();
    let driver = driver_for(engine);
    let session = driver.connect(&params).await?;
    let info = session.info().clone();

    // Remember this connection so the next launch can reconnect automatically.
    if let Err(e) = state.last_connection_store().set(&LastConnection {
        name: name.clone(),
        engine,
        params: params.clone(),
    }) {
        eprintln!("[cubbydb] failed to persist last connection: {e}");
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
    let session = driver.connect(&params).await?;
    let info = session.info().clone();

    if let Err(e) = state.last_connection_store().set(&LastConnection {
        name: name.clone(),
        engine,
        params: params.clone(),
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

    let session = driver_for(engine).connect(&params).await?;
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
) -> Result<QueryResult, DbError> {
    let mut active = state.active.lock().await;
    let connection_name = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .name
        .clone();

    let mut result = active
        .get(&session_id)
        .ok_or_else(DbError::not_connected)?
        .session
        .run_query(&sql)
        .await;

    // If the connection had silently dropped, reconnect once and retry.
    if matches!(&result, Err(e) if e.kind == DbErrorKind::Connection) {
        if let Ok(()) = reconnect_in_place(&mut active, &session_id, &state).await {
            if let Some(session) = active.get(&session_id) {
                result = session.session.run_query(&sql).await;
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
) -> Result<String, DbError> {
    let active = state.active.lock().await;
    let active = active.get(&session_id).ok_or_else(DbError::not_connected)?;
    Ok(active.session.select_top_sql(
        &schema,
        &table,
        filter.as_deref(),
        limit.unwrap_or(DEFAULT_ROW_LIMIT),
        offset.unwrap_or(0),
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
        match session.session.delete_impact(&schema, &table, &primary_keys).await {
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
        match session.session.delete_row_cascade(&schema, &table, &primary_keys).await {
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
