/**
 * Thin, typed wrappers over the Tauri command surface.
 *
 * This is the *only* place the frontend talks to the backend. Every function
 * maps 1:1 to a `#[tauri::command]` in `src-tauri/src/commands.rs`. Errors from
 * the backend are structured `DbError`s; `isDbError` narrows an unknown catch.
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  ActiveConnectionInfo,
  AiChatResult,
  AiChatSummary,
  AiChatThread,
  AiConfigStatus,
  AiFilterResult,
  AiMessage,
  AiModelInfo,
  AiProvider,
  AiReasoningEffort,
  ColumnValue,
  ConnectionInfo,
  ConnectionParams,
  Cubby,
  DbError,
  DeleteImpact,
  FunctionDefinition,
  HistoryEntry,
  LastConnection,
  QueryResult,
  SavedConnection,
  SavedQuery,
  SchemaCompareResult,
  SchemaNode,
  SequenceDetails,
  SshHostKeyProbe,
  TableStructure,
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

/** Reads an SSH bastion's host key without authenticating, and reports
 *  whether it's already trusted (or has changed since it was) — the SSH
 *  tunnel form calls this as the user fills in the bastion host/port, ahead
 *  of any real `connect`/`testConnection`, so trust-on-first-use can be
 *  confirmed (or a changed key caught) before a tunnel actually opens. */
export function probeSshHostKey(
  bastionHost: string,
  bastionPort: number,
): Promise<SshHostKeyProbe> {
  return invoke("probe_ssh_host_key", { bastionHost, bastionPort });
}

/** Records `fingerprint` as trusted for this bastion — call only after the
 *  user has explicitly confirmed it (see `SshHostKeyProbe`'s `status`),
 *  never automatically. */
export function trustSshHostKey(
  bastionHost: string,
  bastionPort: number,
  fingerprint: string,
): Promise<void> {
  return invoke("trust_ssh_host_key", { bastionHost, bastionPort, fingerprint });
}

/** Opens a new session and adds it to the backend's pool — never replaces an
 *  existing one, so connecting to a second database leaves the first live.
 *  Returns the new session's id, used by every call below to address it.
 *
 *  `rememberAsLast` (default `true`) persists this as the connection to
 *  auto-reconnect to on next launch. Pass `false` when re-establishing the
 *  connection that was *just read* from that same store (launch's own
 *  auto-reconnect) — writing the identical record straight back would be a
 *  pure, avoidable disk write. */
export function connect(
  params: ConnectionParams,
  name: string,
  connectionId?: string | null,
  rememberAsLast?: boolean,
): Promise<ActiveConnectionInfo> {
  return invoke("connect", {
    params,
    name,
    connectionId: connectionId ?? null,
    rememberAsLast: rememberAsLast ?? true,
  });
}

export function disconnect(sessionId: string): Promise<void> {
  return invoke("disconnect", { sessionId });
}

/** Flips the read-only guard on an already-connected session in place — no
 *  reconnect, no new database round trip. Read-only is purely a policy this
 *  app enforces on top of an existing connection, unlike a host/port/
 *  credential change, which genuinely needs a fresh connection. */
export function setSessionReadOnly(
  sessionId: string,
  readOnly: boolean,
): Promise<void> {
  return invoke("set_session_read_only", { sessionId, readOnly });
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

/** `page` is zero-based; the driver appends LIMIT/OFFSET for a pageable
 *  statement. Omitted means the first page. */
export function runQuery(
  sessionId: string,
  sql: string,
  page = 0,
): Promise<QueryResult> {
  return invoke("run_query", { sessionId, sql, page });
}

/** Re-run a statement the assistant already ran, to export its full result.
 *  Goes through the same read-only, always-rolled-back path the AI's own
 *  tools use — the SQL came from the model, so it keeps those guarantees. */
export function runReadonlyQuery(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke("run_readonly_query", { sessionId, sql });
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
  sortColumn?: string | null,
  sortDesc?: boolean,
): Promise<string> {
  return invoke("select_top_sql", {
    sessionId,
    schema,
    table,
    filter: filter ?? null,
    limit: limit ?? null,
    offset: offset ?? null,
    sortColumn: sortColumn ?? null,
    sortDesc: sortDesc ?? null,
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

/**
 * Diffs one schema against another — possibly on a different open
 * connection — and generates a best-effort migration SQL script. Read-only;
 * CubbyDB never executes the returned script itself.
 */
export function compareSchemas(
  sourceSessionId: string,
  sourceSchema: string,
  targetSessionId: string,
  targetSchema: string,
): Promise<SchemaCompareResult> {
  return invoke("compare_schemas", {
    sourceSessionId,
    sourceSchema,
    targetSessionId,
    targetSchema,
  });
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

// --- Cubbies ---------------------------------------------------------------

export function listCubbies(): Promise<Cubby[]> {
  return invoke("list_cubbies");
}

export function saveCubby(cubby: Cubby): Promise<Cubby> {
  return invoke("save_cubby", { cubby });
}

export function deleteCubby(id: string): Promise<void> {
  return invoke("delete_cubby", { id });
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

// --- AI assistant ------------------------------------------------------------

export function getAiConfig(): Promise<AiConfigStatus> {
  return invoke("get_ai_config");
}

export function saveAiProvider(provider: AiProvider): Promise<AiConfigStatus> {
  return invoke("save_ai_provider", { provider });
}

export function saveAiConfig(
  provider: AiProvider,
  apiKey: string,
): Promise<AiConfigStatus> {
  return invoke("save_ai_config", { provider, apiKey });
}

export function clearAiConfig(provider: AiProvider): Promise<AiConfigStatus> {
  return invoke("clear_ai_config", { provider });
}

/** Opens Codex CLI's browser-based ChatGPT subscription login. CubbyDB never
 * receives the resulting access or refresh token. */
export function startCodexLogin(): Promise<void> {
  return invoke("start_codex_login");
}

/** Opens Claude Code CLI's browser-based Claude subscription login. CubbyDB
 * never receives the resulting OAuth token. */
export function startClaudeCodeLogin(): Promise<void> {
  return invoke("start_claude_code_login");
}

/** Records acceptance of the AI-provider terms at cubbydb.com/terms — called
 * once, right before a Codex/Claude Code sign-in the user hasn't already
 * accepted. */
export function acceptAiTerms(): Promise<AiConfigStatus> {
  return invoke("accept_ai_terms");
}

/** Signs out of the Codex CLI's current ChatGPT account. */
export function logoutCodex(): Promise<void> {
  return invoke("logout_codex");
}

/** Signs out of the Claude Code CLI's current Claude account. */
export function logoutClaudeCode(): Promise<void> {
  return invoke("logout_claude_code");
}

export function saveAiModel(
  provider: AiProvider,
  model: string,
  supportsEffort: boolean,
): Promise<AiConfigStatus> {
  return invoke("save_ai_model", { provider, model, supportsEffort });
}

export function saveAiReasoningEffort(
  provider: AiProvider,
  effort: AiReasoningEffort,
): Promise<AiConfigStatus> {
  return invoke("save_ai_reasoning_effort", { provider, effort });
}

/** Live-fetches models available to the active API key or Codex account. */
export function listAiModels(): Promise<AiModelInfo[]> {
  return invoke("list_ai_models");
}

/** One AI turn: `messages` is the whole conversation so far (ending in the
 *  newest user message) — the backend is stateless across calls except for
 *  the live DB session, so the full history is resent every time. `schema`
 *  is the connection's already-fetched schema tree; `activeTable` is the
 *  active tab's table, if it's a table tab, so the AI knows what's on screen.
 *  `cubby` is the active cubby's name and tables, if one is open — resent
 *  fresh each turn like `schema`, not snapshotted once. */
export function aiChat(
  sessionId: string,
  schema: SchemaNode[],
  activeTable: { schema: string; table: string } | null,
  cubby: { name: string; tables: { schema: string; table: string }[] } | null,
  messages: AiMessage[],
): Promise<AiChatResult> {
  return invoke("ai_chat", {
    sessionId,
    schema,
    activeTable,
    cubby,
    messages,
  });
}

/** Turns a natural-language description into a WHERE predicate for one
 *  table — the filter bar's AI mode. Stateless: unlike `aiChat` there is no
 *  conversation, just this one description plus whatever is already in the
 *  bar (`currentFilter`), which the AI may refine rather than replace
 *  wholesale. Runs on the same provider, key, and model as the chat panel. */
export function aiGenerateFilter(
  sessionId: string,
  schema: SchemaNode[],
  table: { schema: string; table: string },
  prompt: string,
  currentFilter: string | null,
): Promise<AiFilterResult> {
  return invoke("ai_generate_filter", {
    sessionId,
    schema,
    table,
    prompt,
    currentFilter,
  });
}

// --- Saved AI chats -----------------------------------------------------------
// Scoped by connectionId (a *saved* connection's stable id), not sessionId —
// see the backend's `ai_chats.rs` module doc. Only meaningful for
// connections that have one; ad-hoc connections never call these.

export function listAiChats(connectionId: string): Promise<AiChatSummary[]> {
  return invoke("list_ai_chats", { connectionId });
}

export function getAiChat(id: string): Promise<AiChatThread> {
  return invoke("get_ai_chat", { id });
}

/** Creates (`thread.id` == "") or updates (`thread.id` set) a saved chat.
 *  Pass `title: ""` on every routine turn — an existing title is never
 *  blanked out by an empty incoming one, so this only actually renames via
 *  `renameAiChat`. */
export function upsertAiChat(thread: {
  id: string;
  connectionId: string;
  title: string;
  messages: AiMessage[];
}): Promise<AiChatThread> {
  return invoke("upsert_ai_chat", { thread });
}

export function renameAiChat(id: string, title: string): Promise<AiChatSummary> {
  return invoke("rename_ai_chat", { id, title });
}

export function deleteAiChat(id: string): Promise<void> {
  return invoke("delete_ai_chat", { id });
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

/**
 * Ask for a save location, then write `contents` there. Keeps the whole
 * native round trip in one place: a webview download can only ever land in
 * the browser's download directory, so exports go through the OS save dialog
 * instead — that's what lets the user pick the folder and the filename.
 *
 * Resolves to the path written, or `null` if the dialog was dismissed.
 */
export async function saveTextFile(
  suggestedName: string,
  contents: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const path = await save({ defaultPath: suggestedName, filters });
  if (!path) return null;
  await invoke("write_text_file", { path, contents });
  return path;
}

/**
 * Ask the user to pick a file, then read it back as text — the SSH tunnel
 * form's private-key "Browse…" button. `path` is only for showing the
 * picked filename as feedback; the private key itself is stored by its
 * *contents* (see `SshAuthMethod`'s doc comment in `types.ts`), so nothing
 * beyond this one read keeps the path around.
 *
 * Resolves to `null` if the dialog was dismissed.
 */
export async function pickAndReadTextFile(
  filters?: { name: string; extensions: string[] }[],
): Promise<{ path: string; contents: string } | null> {
  const path = await open({ multiple: false, filters });
  if (!path || Array.isArray(path)) return null;
  const contents = await invoke<string>("read_text_file", { path });
  return { path, contents };
}
