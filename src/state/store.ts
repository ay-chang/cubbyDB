/**
 * Central application store (Zustand).
 *
 * Holds connection state, the schema tree, editor tabs, and query history, and
 * orchestrates the backend calls that mutate them. Components read slices of
 * this and dispatch actions; they never call the backend for stateful flows
 * directly (one-shot actions like "test connection" stay local to their form).
 */

import { create } from "zustand";

import * as api from "../api/backend";
import type {
  ColumnValue,
  CurrentConnection,
  DbError,
  HistoryEntry,
  LastConnection,
  QueryResult,
  SavedConnection,
  SchemaNode,
} from "../types";
import { errorMessage, isDbError } from "../api/backend";

/**
 * A tab is either a `query` tab (SQL editor + results) or a `table` tab
 * (results only — opened by clicking a table in the tree, no editor).
 */
export type TabKind = "query" | "table";

/** One open tab and its most recent execution. */
export interface QueryTab {
  id: string;
  kind: TabKind;
  title: string;
  sql: string;
  result: QueryResult | null;
  error: DbError | null;
  running: boolean;
  /** True once the query has been executed at least once. */
  hasRun: boolean;
  /** For `table` tabs: which relation is being browsed. */
  source?: { schema: string; table: string };
  /** For `table` tabs: the current WHERE-filter predicate, if any. */
  filter?: string;
  /**
   * Unsaved cell edits for a `table` tab: row index (into `result.rows`) ->
   * column index -> new value (`null` = SQL NULL). Cleared whenever the tab's
   * query re-runs or the edits are committed/discarded.
   */
  pendingEdits?: Record<number, Record<number, string | null>>;
  /**
   * Uncommitted new rows added via "Add row", each a full-width array of cell
   * values (`null` = SQL NULL / left to the column default). Inserted on commit.
   */
  newRows?: Array<Array<string | null>>;
  /** Set when the last "Update" commit failed partway through. */
  updateError?: DbError | null;
  /**
   * Zero-based page for `table` tabs — the browser shows `PAGE_SIZE` rows per
   * page via `LIMIT/OFFSET`. Absent (treated as 0) for `query` tabs.
   */
  page?: number;
}

/** How many rows one page of the table browser shows. */
export const PAGE_SIZE = 500;

/** True if a tab has any uncommitted cell edits (but not new rows). */
export function tabHasCellEdits(tab: QueryTab): boolean {
  if (!tab.pendingEdits) return false;
  return Object.values(tab.pendingEdits).some(
    (row) => Object.keys(row).length > 0,
  );
}

/** True if a tab has any unsaved changes — edited cells or pending new rows. */
export function tabHasPendingEdits(tab: QueryTab): boolean {
  return tabHasCellEdits(tab) || (tab.newRows?.length ?? 0) > 0;
}

type View = "connection" | "workspace";

/** The active color theme. Persisted across launches. */
export type Theme = "light" | "dark";

interface ConfirmDialogState {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

interface AppStore {
  view: View;
  /** True while attempting to auto-reconnect on launch. */
  reconnecting: boolean;
  /** Params of the last connection, used to prefill the connect form. */
  lastConnection: LastConnection | null;
  /** Message shown when auto-reconnect failed on launch. */
  reconnectError: string | null;

  savedConnections: SavedConnection[];
  current: CurrentConnection | null;

  schema: SchemaNode[];
  schemaLoading: boolean;
  schemaError: string | null;

  tabs: QueryTab[];
  activeTabId: string | null;

  history: HistoryEntry[];
  historyOpen: boolean;

  /** When set, a "leave without saving?" confirmation is shown. */
  confirmDialog: ConfirmDialogState | null;

  /** Active color theme, applied to the document root. */
  theme: Theme;
  /** True while the settings modal is open. */
  settingsOpen: boolean;

  // --- lifecycle ---
  initialize: () => Promise<void>;
  loadSavedConnections: () => Promise<void>;
  connectTo: (
    connection: Pick<SavedConnection, "params" | "name"> & { id?: string },
  ) => Promise<void>;
  disconnect: () => Promise<void>;

  // --- schema ---
  refreshSchema: () => Promise<void>;

  // --- tabs ---
  newTab: (opts?: { title?: string; sql?: string }) => Promise<string>;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  setTabSql: (id: string, sql: string) => void;
  runTab: (id: string) => Promise<void>;
  openSelectTop: (schema: string, table: string) => Promise<void>;
  setTableFilter: (id: string, filter: string) => Promise<void>;
  openTableWithFilter: (
    schema: string,
    table: string,
    filter: string,
  ) => Promise<void>;

  // --- cell editing ---
  setCellEdit: (
    tabId: string,
    rowIndex: number,
    colIndex: number,
    value: string | null,
  ) => void;
  discardEdits: (tabId: string) => void;
  commitEdits: (tabId: string) => Promise<void>;
  /** Dismiss the last insert/update/delete error shown for a tab. */
  clearUpdateError: (tabId: string) => void;

  // --- row insert / delete / paste (table tabs) ---
  /** Append a blank draft row to be inserted on commit. */
  addRow: (tabId: string) => void;
  /** Append several pre-filled draft rows at once (e.g. pasting duplicates). */
  addRows: (tabId: string, rows: Array<Array<string | null>>) => void;
  /** Edit a cell of a not-yet-committed draft row. */
  setNewCellEdit: (
    tabId: string,
    newRowIndex: number,
    colIndex: number,
    value: string | null,
  ) => void;
  /** Discard a draft row without inserting it. */
  removeNewRow: (tabId: string, newRowIndex: number) => void;
  /** Delete an existing row from the database (confirmed), by row index. */
  deleteExistingRow: (tabId: string, rowIndex: number) => Promise<void>;
  /** Delete several existing rows with a single confirmation. */
  deleteExistingRows: (tabId: string, rowIndices: number[]) => Promise<void>;
  /** Overwrite an existing row's editable cells with pasted values. */
  overwriteRow: (
    tabId: string,
    rowIndex: number,
    values: Array<string | null>,
    editableColIndices: number[],
  ) => void;

  // --- pagination (table tabs) ---
  setTablePage: (tabId: string, page: number) => Promise<void>;

  // --- history ---
  toggleHistory: () => void;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  rerunFromHistory: (sql: string) => void;

  // --- appearance / settings ---
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  openSettings: () => void;
  closeSettings: () => void;
}

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

const STARTER_SQL = "-- Write SQL here, then press Cmd/Ctrl+Enter to run.\nSELECT 1;\n";

function makeTab(opts?: {
  title?: string;
  sql?: string;
  kind?: TabKind;
  source?: { schema: string; table: string };
  filter?: string;
  page?: number;
}): QueryTab {
  return {
    id: nextTabId(),
    kind: opts?.kind ?? "query",
    title: opts?.title ?? "untitled.sql",
    sql: opts?.sql ?? STARTER_SQL,
    result: null,
    error: null,
    running: false,
    hasRun: false,
    source: opts?.source,
    filter: opts?.filter,
    page: opts?.page,
  };
}

const TABS_KEY = "cubbydb:openTabs";
const THEME_KEY = "cubbydb:theme";

/** Read the saved theme, defaulting to light. */
function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Reflect the theme onto <html data-theme> and persist it. */
function applyTheme(theme: Theme) {
  try {
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

// Apply the persisted theme as early as possible (on module load) so there's no
// flash of the wrong theme before the store mounts.
applyTheme(loadTheme());

// Guards against React StrictMode invoking initialize() twice on mount, which
// would open two connections and leave one orphaned.
let didInitialize = false;

/** Build a table-browser query for a given page (backend owns the SQL). */
function tableSql(
  schema: string,
  table: string,
  filter: string | null,
  page: number,
): Promise<string> {
  return api.selectTopSql(schema, table, filter, PAGE_SIZE, page * PAGE_SIZE);
}

/** Persist just enough to restore the open tabs (not their results). */
function persistTabs(tabs: QueryTab[], activeTabId: string | null) {
  try {
    const activeIndex = Math.max(
      0,
      tabs.findIndex((t) => t.id === activeTabId),
    );
    const payload = {
      activeIndex,
      tabs: tabs.map((t) => ({
        kind: t.kind,
        title: t.title,
        sql: t.sql,
        source: t.source,
        filter: t.filter,
        page: t.page,
      })),
    };
    localStorage.setItem(TABS_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable (e.g. non-Tauri context) — non-fatal.
  }
}

/** Rebuild open tabs from storage with fresh ids. */
function loadPersistedTabs(): { tabs: QueryTab[]; activeTabId: string } | null {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.tabs) || payload.tabs.length === 0) return null;
    const tabs: QueryTab[] = payload.tabs.map((t: Partial<QueryTab>) =>
      makeTab({
        kind: t.kind,
        title: t.title,
        sql: t.sql,
        source: t.source,
        filter: t.filter,
        page: t.page,
      }),
    );
    const active = tabs[payload.activeIndex] ?? tabs[0];
    return { tabs, activeTabId: active.id };
  } catch {
    return null;
  }
}

export const useStore = create<AppStore>((set, get) => {
  /**
   * Show a "leave without saving?" confirmation, resolving to whether the
   * user confirmed. Used by every action that would discard unsaved cell
   * edits: switching tabs, closing a tab, or re-running a dirty tab's query.
   */
  function requestConfirm(message: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      set({
        confirmDialog: {
          message,
          confirmLabel,
          onConfirm: () => {
            set({ confirmDialog: null });
            resolve(true);
          },
          onCancel: () => {
            set({ confirmDialog: null });
            resolve(false);
          },
        },
      });
    });
  }

  /**
   * Change the active tab, first confirming if the current tab has unsaved
   * cell edits. Returns whether the switch actually happened.
   */
  async function switchActiveTab(newId: string): Promise<boolean> {
    const current = get().tabs.find((t) => t.id === get().activeTabId);
    if (current && current.id !== newId && tabHasPendingEdits(current)) {
      const ok = await requestConfirm(
        `"${current.title}" has unsaved changes. Leave without saving?`,
        "Leave",
      );
      if (!ok) return false;
      // Confirming "Leave" means abandoning the edits — clear them so the tab
      // is clean if the user comes back, rather than silently retaining them.
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === current.id ? { ...t, pendingEdits: {}, updateError: null } : t,
        ),
      }));
    }
    set({ activeTabId: newId });
    return true;
  }

  return {
    view: "connection",
    reconnecting: true,
    lastConnection: null,
    reconnectError: null,
    savedConnections: [],
    current: null,
    schema: [],
    schemaLoading: false,
    schemaError: null,
    tabs: [],
    activeTabId: null,
    history: [],
    historyOpen: false,
    confirmDialog: null,
    theme: loadTheme(),
    settingsOpen: false,

    async initialize() {
      if (didInitialize) return;
      didInitialize = true;

      await get().loadSavedConnections();

      // Restore the tabs that were open last time (without their stale results).
      const restored = loadPersistedTabs();
      if (restored) {
        set({ tabs: restored.tabs, activeTabId: restored.activeTabId });
      }

      // Try to reconnect to the last-used database so the user doesn't have to
      // re-enter it every launch. Remember its params either way, to prefill the
      // form if the auto-connect fails.
      let last: LastConnection | null = null;
      try {
        last = await api.getLastConnection();
      } catch (err) {
        console.error("failed to read last connection:", errorMessage(err));
      }
      set({ lastConnection: last });

      if (!last) {
        set({ reconnecting: false });
        return;
      }

      try {
        await get().connectTo({ params: last.params, name: last.name });
      } catch (err) {
        // Auto-reconnect failed (server down, creds changed, ...). Fall back to
        // the connect screen, pre-filled, with the reason shown.
        console.error("auto-reconnect failed:", errorMessage(err));
        set({ view: "connection", reconnectError: errorMessage(err) });
      } finally {
        set({ reconnecting: false });
      }
    },

    async loadSavedConnections() {
      try {
        const saved = await api.listSavedConnections();
        set({ savedConnections: saved });
      } catch (err) {
        // Non-fatal: the connection screen still works without saved records.
        console.error("failed to load saved connections:", errorMessage(err));
      }
    },

    async connectTo(connection) {
      await api.connect(connection.params, connection.name, connection.id ?? null);
      const current = await api.currentConnection();

      // Ensure there's at least one editor tab to land in.
      const tabs = get().tabs.length > 0 ? get().tabs : [makeTab()];
      set({
        current,
        view: "workspace",
        tabs,
        activeTabId: get().activeTabId ?? tabs[0].id,
      });

      await get().refreshSchema();

      // Re-populate any restored table tabs (they hold their select-top SQL but
      // no results yet), one at a time. Query tabs keep their SQL and wait for
      // the user to run.
      for (const tab of get().tabs) {
        if (tab.kind === "table" && !tab.result && !tab.error && !tab.running) {
          await get().runTab(tab.id);
        }
      }
    },

    async disconnect() {
      try {
        await api.disconnect();
      } finally {
        set({
          view: "connection",
          current: null,
          schema: [],
          schemaError: null,
          tabs: [],
          activeTabId: null,
          historyOpen: false,
        });
      }
    },

    async refreshSchema() {
      set({ schemaLoading: true, schemaError: null });
      try {
        const schema = await api.fetchSchema();
        set({ schema, schemaLoading: false });
      } catch (err) {
        set({ schemaLoading: false, schemaError: errorMessage(err) });
      }
    },

    async newTab(opts) {
      const tab = makeTab(opts);
      set((s) => ({ tabs: [...s.tabs, tab] }));
      await switchActiveTab(tab.id);
      return tab.id;
    },

    closeTab(id) {
      const doClose = () => {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return s;
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) {
            const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
            activeTabId = neighbor ? neighbor.id : null;
          }
          return { tabs, activeTabId };
        });
      };

      const tab = get().tabs.find((t) => t.id === id);
      if (tab && tabHasPendingEdits(tab)) {
        void requestConfirm(
          `"${tab.title}" has unsaved changes. Close without saving?`,
          "Close",
        ).then((ok) => {
          if (ok) doClose();
        });
        return;
      }
      doClose();
    },

    setActiveTab(id) {
      if (id === get().activeTabId) return;
      void switchActiveTab(id);
    },

    reorderTab(fromIndex, toIndex) {
      set((s) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= s.tabs.length ||
          toIndex >= s.tabs.length
        ) {
          return s;
        }
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved);
        return { tabs };
      });
    },

    setTabSql(id, sql) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql } : t)),
      }));
    },

    async runTab(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.running) return;

      if (tabHasPendingEdits(tab)) {
        const ok = await requestConfirm(
          `"${tab.title}" has unsaved changes. Refresh and lose them?`,
          "Refresh",
        );
        if (!ok) return;
      }

      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                running: true,
                error: null,
                updateError: null,
                pendingEdits: {},
                newRows: [],
              }
            : t,
        ),
      }));

      try {
        const result = await api.runQuery(tab.sql);
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? { ...t, running: false, hasRun: true, result, error: null }
              : t,
          ),
        }));
      } catch (err) {
        const dbError: DbError = isDbError(err)
          ? err
          : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? { ...t, running: false, hasRun: true, error: dbError }
              : t,
          ),
        }));
      } finally {
        // Reflect the just-logged query in the history panel if it's open.
        if (get().historyOpen) void get().refreshHistory();
      }
    },

    async openSelectTop(schema, table) {
      // If this table is already open, just focus its tab.
      const existing = get().tabs.find(
        (t) =>
          t.kind === "table" &&
          t.source?.schema === schema &&
          t.source?.table === table,
      );
      if (existing) {
        await switchActiveTab(existing.id);
        return;
      }

      const sql = await tableSql(schema, table, null, 0);
      const tab = makeTab({
        kind: "table",
        title: table,
        sql,
        source: { schema, table },
        page: 0,
      });
      set((s) => ({ tabs: [...s.tabs, tab] }));
      const switched = await switchActiveTab(tab.id);
      if (!switched) {
        // The user chose to stay on the current (dirty) tab — remove the tab
        // we speculatively created rather than leaving an unopened orphan.
        set((s) => ({ tabs: s.tabs.filter((t) => t.id !== tab.id) }));
        return;
      }
      await get().runTab(tab.id);
    },

    async openTableWithFilter(schema, table, filter) {
      // Used by FK navigation: open (or focus) the referenced table showing only
      // the matching row. Backend builds the SQL from the filter predicate.
      const existing = get().tabs.find(
        (t) =>
          t.kind === "table" &&
          t.source?.schema === schema &&
          t.source?.table === table,
      );
      if (existing) {
        const switched = await switchActiveTab(existing.id);
        if (!switched) return;
        const sql = await tableSql(schema, table, filter.trim() || null, 0);
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === existing.id
              ? { ...t, sql, filter: filter.trim() || undefined, page: 0 }
              : t,
          ),
        }));
        await get().runTab(existing.id);
        return;
      }

      const sql = await tableSql(schema, table, filter.trim() || null, 0);
      const tab = makeTab({
        kind: "table",
        title: table,
        sql,
        source: { schema, table },
        filter: filter.trim() || undefined,
        page: 0,
      });
      set((s) => ({ tabs: [...s.tabs, tab] }));
      const switched = await switchActiveTab(tab.id);
      if (!switched) {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id !== tab.id) }));
        return;
      }
      await get().runTab(tab.id);
    },

    async setTableFilter(id, filter) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || !tab.source) return;
      // Regenerate the table query with the WHERE predicate in the backend.
      // Changing the filter resets to the first page. `runTab` itself guards
      // against discarding unsaved edits.
      const sql = await tableSql(
        tab.source.schema,
        tab.source.table,
        filter.trim() || null,
        0,
      );
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? { ...t, sql, filter: filter.trim() || undefined, page: 0 }
            : t,
        ),
      }));
      await get().runTab(id);
    },

    setCellEdit(tabId, rowIndex, colIndex, value) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || !t.result) return t;
          // Compare against the real original (which may be null) — coercing
          // null to "" here would wrongly mark a null->null edit as dirty and
          // fail to detect a genuine null<->text change.
          const original = t.result.rows[rowIndex]?.[colIndex] ?? null;
          const rowEdits = { ...(t.pendingEdits?.[rowIndex] ?? {}) };
          if (value === original) {
            delete rowEdits[colIndex];
          } else {
            rowEdits[colIndex] = value;
          }
          const pendingEdits = { ...t.pendingEdits };
          if (Object.keys(rowEdits).length > 0) {
            pendingEdits[rowIndex] = rowEdits;
          } else {
            delete pendingEdits[rowIndex];
          }
          return { ...t, pendingEdits };
        }),
      }));
    },

    discardEdits(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, pendingEdits: {}, newRows: [], updateError: null }
            : t,
        ),
      }));
    },

    clearUpdateError(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, updateError: null } : t,
        ),
      }));
    },

    async commitEdits(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || !tab.result || !tab.source || !tabHasPendingEdits(tab)) return;

      const schemaTable = get()
        .schema.find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table);
      const pkCols = schemaTable?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
      if (pkCols.length === 0) return; // editing is gated on a detected primary key

      const rowIndices = Object.keys(tab.pendingEdits ?? {}).map(Number);

      for (const rowIndex of rowIndices) {
        // Re-read fresh each iteration: prior rows in this loop have already
        // patched `result`/`pendingEdits` in place.
        const current = get().tabs.find((t) => t.id === tabId);
        if (!current || !current.result || !current.pendingEdits) break;
        const rowEdits = current.pendingEdits[rowIndex];
        const colIndices = Object.keys(rowEdits ?? {}).map(Number);
        if (!rowEdits || colIndices.length === 0) continue;

        const primaryKey: ColumnValue[] = pkCols.map((pkCol) => {
          const pkColIndex = current.result!.columns.findIndex((c) => c.name === pkCol);
          return { column: pkCol, value: current.result!.rows[rowIndex][pkColIndex] ?? "" };
        });
        const changes: ColumnValue[] = colIndices.map((ci) => ({
          column: current.result!.columns[ci].name,
          value: rowEdits[ci],
        }));

        try {
          await api.updateRow(tab.source.schema, tab.source.table, primaryKey, changes);
          // Apply the change locally so the grid reflects the saved values
          // without a full re-fetch.
          set((s) => ({
            tabs: s.tabs.map((t) => {
              if (t.id !== tabId || !t.result) return t;
              const newRows = t.result.rows.map((row, ri) => {
                if (ri !== rowIndex) return row;
                const newRow = [...row];
                for (const ci of colIndices) newRow[ci] = rowEdits[ci];
                return newRow;
              });
              const restEdits = { ...t.pendingEdits };
              delete restEdits[rowIndex];
              return {
                ...t,
                result: { ...t.result, rows: newRows },
                pendingEdits: restEdits,
                updateError: null,
              };
            }),
          }));
        } catch (err) {
          // Stop on the first failure; leave remaining edits pending so
          // nothing already-typed is lost.
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
          }));
          return;
        }
      }

      // Insert any pending draft rows. Always process the first remaining draft
      // and drop it on success, so a mid-batch failure leaves the offender (and
      // everything after it) still queued for the user to fix.
      let insertedAny = false;
      for (;;) {
        const current = get().tabs.find((t) => t.id === tabId);
        const draft = current?.newRows?.[0];
        if (!current || !current.result || !draft) break;

        const columns = current.result.columns;
        // Only send columns the user filled in — untouched (null) cells take
        // their database default, so a blank draft becomes DEFAULT VALUES.
        const values: ColumnValue[] = [];
        draft.forEach((v, ci) => {
          if (v !== null && columns[ci]) {
            values.push({ column: columns[ci].name, value: v });
          }
        });

        try {
          await api.insertRow(tab.source.schema, tab.source.table, values);
          insertedAny = true;
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? { ...t, newRows: (t.newRows ?? []).slice(1), updateError: null }
                : t,
            ),
          }));
        } catch (err) {
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
          }));
          return;
        }
      }

      // Re-fetch so inserted rows appear with server-assigned defaults/keys.
      if (insertedAny) await get().runTab(tabId);
    },

    addRow(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || !t.result) return t;
          const blank = Array<string | null>(t.result.columns.length).fill(null);
          return { ...t, newRows: [...(t.newRows ?? []), blank] };
        }),
      }));
    },

    addRows(tabId, rows) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || !t.result || rows.length === 0) return t;
          const width = t.result.columns.length;
          const drafts = rows.map((r) => {
            const row = Array<string | null>(width).fill(null);
            for (let ci = 0; ci < width; ci++) row[ci] = r[ci] ?? null;
            return row;
          });
          return { ...t, newRows: [...(t.newRows ?? []), ...drafts] };
        }),
      }));
    },

    setNewCellEdit(tabId, newRowIndex, colIndex, value) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || !t.newRows) return t;
          const newRows = t.newRows.map((row, i) => {
            if (i !== newRowIndex) return row;
            const copy = [...row];
            copy[colIndex] = value;
            return copy;
          });
          return { ...t, newRows };
        }),
      }));
    },

    removeNewRow(tabId, newRowIndex) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.newRows
            ? { ...t, newRows: t.newRows.filter((_, i) => i !== newRowIndex) }
            : t,
        ),
      }));
    },

    async deleteExistingRow(tabId, rowIndex) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || !tab.result || !tab.source) return;

      const schemaTable = get()
        .schema.find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table);
      const pkCols = schemaTable?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
      if (pkCols.length === 0) return; // deletion is gated on a detected primary key

      const ok = await requestConfirm(
        "Delete this row? This permanently removes it from the database.",
        "Delete",
      );
      if (!ok) return;

      // Re-resolve the row after the async confirm (it may have shifted).
      const fresh = get().tabs.find((t) => t.id === tabId);
      const row = fresh?.result?.rows[rowIndex];
      if (!fresh || !fresh.result || !row) return;

      const primaryKey: ColumnValue[] = pkCols.map((pkCol) => {
        const ci = fresh.result!.columns.findIndex((c) => c.name === pkCol);
        return { column: pkCol, value: row[ci] ?? null };
      });

      try {
        await api.deleteRow(tab.source.schema, tab.source.table, primaryKey);
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || !t.result) return t;
            const rows = t.result.rows.filter((_, i) => i !== rowIndex);
            // Re-index pending edits around the removed row.
            const pendingEdits: Record<number, Record<number, string | null>> = {};
            for (const [k, v] of Object.entries(t.pendingEdits ?? {})) {
              const ri = Number(k);
              if (ri === rowIndex) continue;
              pendingEdits[ri > rowIndex ? ri - 1 : ri] = v;
            }
            return {
              ...t,
              result: { ...t.result, rows, rowCount: Math.max(0, t.result.rowCount - 1) },
              pendingEdits,
              updateError: null,
            };
          }),
        }));
      } catch (err) {
        const dbError: DbError = isDbError(err)
          ? err
          : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
        }));
      }
    },

    async deleteExistingRows(tabId, rowIndices) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || !tab.result || !tab.source || rowIndices.length === 0) return;

      const schemaTable = get()
        .schema.find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table);
      const pkCols = schemaTable?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
      if (pkCols.length === 0) return;

      const n = rowIndices.length;
      const ok = await requestConfirm(
        n === 1
          ? "Delete this row? This permanently removes it from the database."
          : `Delete ${n} rows? This permanently removes them from the database.`,
        "Delete",
      );
      if (!ok) return;

      // Delete from the highest index down so each removal doesn't shift the
      // indices of rows we haven't handled yet. Stop at the first failure and
      // surface it (rows already deleted stay deleted).
      const sorted = [...new Set(rowIndices)].sort((a, b) => b - a);
      for (const rowIndex of sorted) {
        const fresh = get().tabs.find((t) => t.id === tabId);
        const row = fresh?.result?.rows[rowIndex];
        if (!fresh || !fresh.result || !row) continue;

        const primaryKey: ColumnValue[] = pkCols.map((pkCol) => {
          const ci = fresh.result!.columns.findIndex((c) => c.name === pkCol);
          return { column: pkCol, value: row[ci] ?? null };
        });

        try {
          await api.deleteRow(tab.source.schema, tab.source.table, primaryKey);
          set((s) => ({
            tabs: s.tabs.map((t) => {
              if (t.id !== tabId || !t.result) return t;
              const rows = t.result.rows.filter((_, i) => i !== rowIndex);
              const pendingEdits: Record<number, Record<number, string | null>> = {};
              for (const [k, v] of Object.entries(t.pendingEdits ?? {})) {
                const ri = Number(k);
                if (ri === rowIndex) continue;
                pendingEdits[ri > rowIndex ? ri - 1 : ri] = v;
              }
              return {
                ...t,
                result: { ...t.result, rows, rowCount: Math.max(0, t.result.rowCount - 1) },
                pendingEdits,
                updateError: null,
              };
            }),
          }));
        } catch (err) {
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
          }));
          return;
        }
      }
    },

    overwriteRow(tabId, rowIndex, values, editableColIndices) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || !t.result) return t;
          const original = t.result.rows[rowIndex];
          if (!original) return t;
          const rowEdits = { ...(t.pendingEdits?.[rowIndex] ?? {}) };
          for (const ci of editableColIndices) {
            const v = values[ci] ?? null;
            if (v === (original[ci] ?? null)) {
              delete rowEdits[ci];
            } else {
              rowEdits[ci] = v;
            }
          }
          const pendingEdits = { ...t.pendingEdits };
          if (Object.keys(rowEdits).length > 0) {
            pendingEdits[rowIndex] = rowEdits;
          } else {
            delete pendingEdits[rowIndex];
          }
          return { ...t, pendingEdits };
        }),
      }));
    },

    async setTablePage(tabId, page) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || !tab.source || tab.running) return;
      const next = Math.max(0, page);
      if (next === (tab.page ?? 0)) return;
      const sql = await tableSql(
        tab.source.schema,
        tab.source.table,
        tab.filter?.trim() || null,
        next,
      );
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sql, page: next } : t)),
      }));
      await get().runTab(tabId);
    },

    toggleHistory() {
      const next = !get().historyOpen;
      set({ historyOpen: next });
      if (next) void get().refreshHistory();
    },

    async refreshHistory() {
      try {
        const history = await api.queryHistory(200);
        set({ history });
      } catch (err) {
        console.error("failed to load history:", errorMessage(err));
      }
    },

    async clearHistory() {
      try {
        await api.clearQueryHistory();
        set({ history: [] });
      } catch (err) {
        console.error("failed to clear history:", errorMessage(err));
      }
    },

    rerunFromHistory(sql) {
      void (async () => {
        const id = await get().newTab({ title: "history.sql", sql });
        await get().runTab(id);
      })();
    },

    setTheme(theme) {
      applyTheme(theme);
      set({ theme });
    },

    toggleTheme() {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      applyTheme(next);
      set({ theme: next });
    },

    openSettings() {
      set({ settingsOpen: true });
    },

    closeSettings() {
      set({ settingsOpen: false });
    },
  };
});

// Persist the open tabs whenever the set of tabs or the active tab changes, so
// they can be restored on the next launch.
let lastTabs = useStore.getState().tabs;
let lastActive = useStore.getState().activeTabId;
useStore.subscribe((state) => {
  if (state.tabs !== lastTabs || state.activeTabId !== lastActive) {
    lastTabs = state.tabs;
    lastActive = state.activeTabId;
    persistTabs(state.tabs, state.activeTabId);
  }
});
