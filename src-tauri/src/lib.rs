//! CubbyDB library entry point.
//!
//! Module layout:
//! - [`db`]         — the engine-agnostic driver interface and the Postgres impl
//! - [`connections`]— saved-connection persistence
//! - [`history`]    — query history log
//! - [`state`]      — Tauri-managed application state
//! - [`commands`]   — the command surface exposed to the frontend

mod commands;
mod connections;
mod db;
mod history;
mod keychain;
mod saved_queries;
mod state;

use tauri::Manager;

use state::AppState;

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The data directory holds connections.json and history.jsonl.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState::new(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_saved_connections,
            commands::get_saved_connection,
            commands::save_connection,
            commands::delete_connection,
            commands::list_saved_queries,
            commands::save_query,
            commands::delete_saved_query,
            commands::test_connection,
            commands::connect,
            commands::reconnect_session,
            commands::disconnect,
            commands::get_last_connection,
            commands::fetch_schema,
            commands::run_query,
            commands::cancel_query,
            commands::select_top_sql,
            commands::update_row,
            commands::insert_row,
            commands::delete_row,
            commands::get_delete_impact,
            commands::delete_rows_cascade,
            commands::get_table_structure,
            commands::get_function_definition,
            commands::get_sequence_details,
            commands::write_clipboard,
            commands::read_clipboard,
            commands::query_history,
            commands::clear_query_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CubbyDB");
}
