//! Tauri command surface — the bridge between the React frontend and the
//! database layer. Commands speak only in the neutral `db` types; no SQL is
//! constructed here or on the frontend (except the user's editor text).

use tauri::State;

use crate::connections::{LastConnection, SavedConnection};
use crate::db::{
    driver_for, ConnectionInfo, ConnectionParams, DbError, DbErrorKind, Engine, QueryResult,
    SchemaNode, DEFAULT_ROW_LIMIT,
};
use crate::history::{now_millis, HistoryEntry};
use crate::state::{ActiveSession, AppState};

/// Snapshot of the active connection for the UI top bar.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentConnection {
    pub name: String,
    pub connection_id: Option<String>,
    pub info: ConnectionInfo,
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

// --- Connect / test --------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    params: ConnectionParams,
    engine: Option<Engine>,
) -> Result<ConnectionInfo, DbError> {
    let driver = driver_for(engine.unwrap_or_default());
    driver.test_connection(&params).await
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    params: ConnectionParams,
    name: String,
    engine: Option<Engine>,
    connection_id: Option<String>,
) -> Result<ConnectionInfo, DbError> {
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

    let mut active = state.active.lock().await;
    *active = Some(ActiveSession {
        session,
        name,
        connection_id,
        params,
        engine,
    });
    Ok(info)
}

/// Re-establish a dropped session in place, reusing its stored parameters.
/// Returns an error if there was no session to reconnect.
async fn reconnect_in_place(
    active: &mut Option<ActiveSession>,
) -> Result<(), DbError> {
    let old = active.as_ref().ok_or_else(DbError::not_connected)?;
    let params = old.params.clone();
    let engine = old.engine;
    let name = old.name.clone();
    let connection_id = old.connection_id.clone();

    let session = driver_for(engine).connect(&params).await?;
    *active = Some(ActiveSession {
        session,
        name,
        connection_id,
        params,
        engine,
    });
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), DbError> {
    *state.active.lock().await = None;
    // An explicit disconnect opts out of auto-reconnect next launch.
    if let Err(e) = state.last_connection_store().clear() {
        eprintln!("[cubbydb] failed to clear last connection: {e}");
    }
    Ok(())
}

/// The last connection's parameters, for auto-reconnect on launch.
#[tauri::command]
pub async fn get_last_connection(
    state: State<'_, AppState>,
) -> Result<Option<LastConnection>, DbError> {
    state.last_connection_store().get()
}

#[tauri::command]
pub async fn current_connection(
    state: State<'_, AppState>,
) -> Result<Option<CurrentConnection>, DbError> {
    let active = state.active.lock().await;
    Ok(active.as_ref().map(|a| CurrentConnection {
        name: a.name.clone(),
        connection_id: a.connection_id.clone(),
        info: a.session.info().clone(),
    }))
}

// --- Schema / query --------------------------------------------------------

#[tauri::command]
pub async fn fetch_schema(state: State<'_, AppState>) -> Result<Vec<SchemaNode>, DbError> {
    let mut active = state.active.lock().await;
    {
        let session = active.as_ref().ok_or_else(DbError::not_connected)?;
        match session.session.fetch_schema().await {
            Err(e) if e.kind == DbErrorKind::Connection => { /* retry below */ }
            other => return other,
        }
    }
    // The connection had dropped — reconnect once and try again.
    reconnect_in_place(&mut active).await?;
    active
        .as_ref()
        .ok_or_else(DbError::not_connected)?
        .session
        .fetch_schema()
        .await
}

#[tauri::command]
pub async fn run_query(state: State<'_, AppState>, sql: String) -> Result<QueryResult, DbError> {
    let mut active = state.active.lock().await;
    let connection_name = active
        .as_ref()
        .ok_or_else(DbError::not_connected)?
        .name
        .clone();

    let mut result = active
        .as_ref()
        .ok_or_else(DbError::not_connected)?
        .session
        .run_query(&sql)
        .await;

    // If the connection had silently dropped, reconnect once and retry.
    if matches!(&result, Err(e) if e.kind == DbErrorKind::Connection) {
        if let Ok(()) = reconnect_in_place(&mut active).await {
            if let Some(session) = active.as_ref() {
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
    schema: String,
    table: String,
    filter: Option<String>,
    limit: Option<u32>,
) -> Result<String, DbError> {
    let active = state.active.lock().await;
    let active = active.as_ref().ok_or_else(DbError::not_connected)?;
    Ok(active.session.select_top_sql(
        &schema,
        &table,
        filter.as_deref(),
        limit.unwrap_or(DEFAULT_ROW_LIMIT),
    ))
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
