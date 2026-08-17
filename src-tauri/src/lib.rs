//! CubbyDB library entry point.
//!
//! Module layout:
//! - [`ai`]         — the AI assistant service (prompt, provider, tools, persistence)
//! - [`db`]         — the engine-agnostic driver interface and the Postgres impl
//! - [`connections`]— saved-connection persistence
//! - [`history`]    — query history log
//! - [`state`]      — Tauri-managed application state
//! - [`commands`]   — the command surface exposed to the frontend

mod ai;
mod commands;
mod connections;
mod cubbies;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The data directory holds connections.json and history.jsonl.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState::new(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_saved_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::list_saved_queries,
            commands::save_query,
            commands::delete_saved_query,
            commands::list_cubbies,
            commands::save_cubby,
            commands::delete_cubby,
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
            commands::write_text_file,
            commands::run_readonly_query,
            commands::read_clipboard,
            commands::query_history,
            commands::clear_query_history,
            commands::get_ai_config,
            commands::save_ai_provider,
            commands::save_ai_config,
            commands::clear_ai_config,
            commands::start_codex_login,
            commands::start_claude_code_login,
            commands::logout_codex,
            commands::logout_claude_code,
            commands::save_ai_model,
            commands::save_ai_reasoning_effort,
            commands::accept_ai_terms,
            commands::list_ai_models,
            commands::ai_chat,
            commands::list_ai_chats,
            commands::get_ai_chat,
            commands::upsert_ai_chat,
            commands::rename_ai_chat,
            commands::delete_ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CubbyDB");
}
