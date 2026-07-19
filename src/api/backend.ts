/**
 * Thin, typed wrappers over the Tauri command surface.
 *
 * This is the *only* place the frontend talks to the backend. Every function
 * maps 1:1 to a `#[tauri::command]` in `src-tauri/src/commands.rs`. Errors from
 * the backend are structured `DbError`s; `isDbError` narrows an unknown catch.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  ColumnValue,
  ConnectionInfo,
  ConnectionParams,
  CurrentConnection,
  DbError,
  HistoryEntry,
  LastConnection,
  QueryResult,
  SavedConnection,
  SchemaNode,
} from "../types";

export function listSavedConnections(): Promise<SavedConnection[]> {
  return invoke("list_saved_connections");
}

export function saveConnection(
  connection: SavedConnection,
): Promise<SavedConnection> {
  return invoke("save_connection", { connection });
}

export function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export function testConnection(
  params: ConnectionParams,
): Promise<ConnectionInfo> {
  return invoke("test_connection", { params });
}

export function connect(
  params: ConnectionParams,
  name: string,
  connectionId?: string | null,
): Promise<ConnectionInfo> {
  return invoke("connect", { params, name, connectionId: connectionId ?? null });
}

export function disconnect(): Promise<void> {
  return invoke("disconnect");
}

export function currentConnection(): Promise<CurrentConnection | null> {
  return invoke("current_connection");
}

export function getLastConnection(): Promise<LastConnection | null> {
  return invoke("get_last_connection");
}

export function fetchSchema(): Promise<SchemaNode[]> {
  return invoke("fetch_schema");
}

export function runQuery(sql: string): Promise<QueryResult> {
  return invoke("run_query", { sql });
}

export function selectTopSql(
  schema: string,
  table: string,
  filter?: string | null,
  limit?: number,
  offset?: number,
): Promise<string> {
  return invoke("select_top_sql", {
    schema,
    table,
    filter: filter ?? null,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export function updateRow(
  schema: string,
  table: string,
  primaryKey: ColumnValue[],
  changes: ColumnValue[],
): Promise<void> {
  return invoke("update_row", { schema, table, primaryKey, changes });
}

export function insertRow(
  schema: string,
  table: string,
  values: ColumnValue[],
): Promise<void> {
  return invoke("insert_row", { schema, table, values });
}

export function deleteRow(
  schema: string,
  table: string,
  primaryKey: ColumnValue[],
): Promise<void> {
  return invoke("delete_row", { schema, table, primaryKey });
}

/** Copy text to the OS clipboard (via the backend — see the Rust command). */
export function writeClipboard(text: string): Promise<void> {
  return invoke("write_clipboard", { text });
}

/** Read text from the OS clipboard. */
export function readClipboard(): Promise<string> {
  return invoke("read_clipboard");
}

/**
 * Copy text to the clipboard as reliably as possible from the Tauri webview.
 * Runs a synchronous, user-gesture-based `execCommand("copy")` (which works
 * inside WKWebView with no backend at all — so it survives a not-yet-restarted
 * dev build) AND fires the backend command as a second, best-effort path.
 * Call it synchronously from within a user gesture (e.g. a keydown handler).
 */
export function copyToClipboard(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    // execCommand unavailable — the backend path below is the fallback.
  }
  void writeClipboard(text).catch(() => {});
}

export function queryHistory(limit?: number): Promise<HistoryEntry[]> {
  return invoke("query_history", { limit: limit ?? null });
}

export function clearQueryHistory(): Promise<void> {
  return invoke("clear_query_history");
}

/** Narrow an unknown thrown value to a structured `DbError`. */
export function isDbError(value: unknown): value is DbError {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    "kind" in value
  );
}

/** Best-effort extraction of a human message from any thrown value. */
export function errorMessage(value: unknown): string {
  if (isDbError(value)) return value.message;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}
