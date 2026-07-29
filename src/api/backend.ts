/**
 * Thin, typed wrappers over the Tauri command surface.
 *
 * This is the *only* place the frontend talks to the backend. Every function
 * maps 1:1 to a `#[tauri::command]` in `src-tauri/src/commands.rs`. Errors from
 * the backend are structured `DbError`s; `isDbError` narrows an unknown catch.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  ActiveConnectionInfo,
  ColumnValue,
  ConnectionInfo,
  ConnectionParams,
  DbError,
  DeleteImpact,
  FunctionDefinition,
  HistoryEntry,
  LastConnection,
  QueryResult,
  SavedConnection,
  SavedQuery,
  SchemaNode,
  SequenceDetails,
  TableStructure,
} from "../types";

export function listSavedConnections(): Promise<SavedConnection[]> {
  return invoke("list_saved_connections");
}

/** One saved connection with its real password rehydrated from the OS
 *  keychain — call right before connecting to (or editing) a saved entry,
 *  not for the picker list itself (`listSavedConnections` covers that
 *  without triggering a keychain prompt per entry). */
export function getSavedConnection(id: string): Promise<SavedConnection | null> {
  return invoke("get_saved_connection", { id });
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

/** Opens a new session and adds it to the backend's pool — never replaces an
 *  existing one, so connecting to a second database leaves the first live.
 *  Returns the new session's id, used by every call below to address it. */
export function connect(
  params: ConnectionParams,
  name: string,
  connectionId?: string | null,
): Promise<ActiveConnectionInfo> {
  return invoke("connect", { params, name, connectionId: connectionId ?? null });
}

export function disconnect(sessionId: string): Promise<void> {
  return invoke("disconnect", { sessionId });
}

/** Re-establishes an *existing* session with edited params/name, keeping the
 *  same session id (so its tabs/schema slot isn't lost) — used when editing
 *  "the connection I'm on" rather than opening an additional one. */
export function reconnectSession(
  sessionId: string,
  params: ConnectionParams,
  name: string,
  connectionId?: string | null,
): Promise<ActiveConnectionInfo> {
  return invoke("reconnect_session", {
    sessionId,
    params,
    name,
    connectionId: connectionId ?? null,
  });
}

export function getLastConnection(): Promise<LastConnection | null> {
  return invoke("get_last_connection");
}

export function fetchSchema(sessionId: string): Promise<SchemaNode[]> {
  return invoke("fetch_schema", { sessionId });
}

export function runQuery(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke("run_query", { sessionId, sql });
}

/** Ask the server to interrupt whatever's currently running on this session.
 *  A no-op if nothing is running. */
export function cancelQuery(sessionId: string): Promise<void> {
  return invoke("cancel_query", { sessionId });
}

export function selectTopSql(
  sessionId: string,
  schema: string,
  table: string,
  filter?: string | null,
  limit?: number,
  offset?: number,
): Promise<string> {
  return invoke("select_top_sql", {
    sessionId,
    schema,
    table,
    filter: filter ?? null,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export function updateRow(
  sessionId: string,
  schema: string,
  table: string,
  primaryKey: ColumnValue[],
  changes: ColumnValue[],
): Promise<void> {
  return invoke("update_row", { sessionId, schema, table, primaryKey, changes });
}

export function insertRow(
  sessionId: string,
  schema: string,
  table: string,
  values: ColumnValue[],
): Promise<void> {
  return invoke("insert_row", { sessionId, schema, table, values });
}

export function deleteRow(
  sessionId: string,
  schema: string,
  table: string,
  primaryKey: ColumnValue[],
): Promise<void> {
  return invoke("delete_row", { sessionId, schema, table, primaryKey });
}

/** Read-only preview of what deleting `primaryKeys` would cascade into. */
export function getDeleteImpact(
  sessionId: string,
  schema: string,
  table: string,
  primaryKeys: ColumnValue[][],
): Promise<DeleteImpact> {
  return invoke("get_delete_impact", { sessionId, schema, table, primaryKeys });
}

/** Deletes `primaryKeys` and everything `getDeleteImpact` reported for them,
 *  in one transaction. Resolves with the total number of rows deleted. */
export function deleteRowsCascade(
  sessionId: string,
  schema: string,
  table: string,
  primaryKeys: ColumnValue[][],
): Promise<number> {
  return invoke("delete_rows_cascade", { sessionId, schema, table, primaryKeys });
}

/** Column, index, and check-constraint details for one table. */
export function getTableStructure(
  sessionId: string,
  schema: string,
  table: string,
): Promise<TableStructure> {
  return invoke("get_table_structure", { sessionId, schema, table });
}

/** A function/procedure's full body, by oid. */
export function getFunctionDefinition(
  sessionId: string,
  oid: number,
): Promise<FunctionDefinition> {
  return invoke("get_function_definition", { sessionId, oid });
}

/** One sequence's current value and configuration. */
export function getSequenceDetails(
  sessionId: string,
  schema: string,
  name: string,
): Promise<SequenceDetails> {
  return invoke("get_sequence_details", { sessionId, schema, name });
}

export function listSavedQueries(): Promise<SavedQuery[]> {
  return invoke("list_saved_queries");
}

export function saveQuery(query: SavedQuery): Promise<SavedQuery> {
  return invoke("save_query", { query });
}

export function deleteSavedQuery(id: string): Promise<void> {
  return invoke("delete_saved_query", { id });
}

/** Copy text to the OS clipboard (via the backend — see the Rust command). */
export function writeClipboard(text: string): Promise<void> {
  return invoke("write_clipboard", { text });
}

/** Read text from the OS clipboard. */
export function readClipboard(): Promise<string> {
  return invoke("read_clipboard");
}

/** Per-method outcome of a copy attempt, for on-screen diagnostics. */
export interface CopyResult {
  text: string;
  /** Any method wrote the text successfully. */
  ok: boolean;
  execOk: boolean;
  navOk: boolean;
  backendOk: boolean;
  /** First error message from the async methods, if any failed. */
  error: string | null;
}

/**
 * Copy text to the clipboard as reliably as possible from the Tauri webview,
 * trying every available method (they all write the same text, so redundancy is
 * harmless). Call it synchronously from within a user gesture (e.g. a keydown
 * handler) so the `execCommand` path keeps its user activation.
 *
 *   1. `execCommand("copy")` — synchronous, no backend needed.
 *   2. `navigator.clipboard.writeText` — the standard async API.
 *   3. the backend `write_clipboard` command — needs the app rebuilt.
 *
 * Resolves with which methods worked, so callers can show a status.
 */
export function copyToClipboard(text: string): Promise<CopyResult> {
  // Intercept the synchronous `copy` event that `execCommand("copy")` fires and
  // write the value with `clipboardData.setData()`. Unlike "select an off-screen
  // textarea and let WebKit read it" (which WKWebView reports as succeeding while
  // copying nothing), setting the data explicitly inside the copy event IS
  // honored by WebKit — it's the same path a manual ⌘C takes. A momentarily
  // selected textarea guarantees `execCommand` actually fires the event.
  let execOk = false;
  try {
    const active = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.contain = "strict";
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    ta.style.top = `${window.scrollY}px`;
    ta.style.fontSize = "12pt";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);

    const onCopy = (e: ClipboardEvent) => {
      e.clipboardData?.setData("text/plain", text);
      e.preventDefault();
      execOk = true;
    };
    document.addEventListener("copy", onCopy, true);
    document.execCommand("copy");
    document.removeEventListener("copy", onCopy, true);

    document.body.removeChild(ta);
    if (active && typeof active.focus === "function") active.focus();
  } catch (e) {
    console.warn("[clipboard] copy-event write failed:", e);
  }

  let error: string | null = null;

  const navPromise: Promise<boolean> = navigator?.clipboard?.writeText
    ? navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch((e) => {
          error = error ?? `navigator: ${errorMessage(e)}`;
          return false;
        })
    : Promise.resolve(false);

  const backendPromise: Promise<boolean> = writeClipboard(text)
    .then(() => true)
    .catch((e) => {
      error = error ?? `backend: ${errorMessage(e)}`;
      return false;
    });

  return Promise.all([navPromise, backendPromise]).then(([navOk, backendOk]) => ({
    text,
    ok: execOk || navOk || backendOk,
    execOk,
    navOk,
    backendOk,
    error,
  }));
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
