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
}

type View = "connection" | "workspace";

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
  newTab: (opts?: { title?: string; sql?: string }) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setTabSql: (id: string, sql: string) => void;
  runTab: (id: string) => Promise<void>;
  openSelectTop: (schema: string, table: string) => Promise<void>;
  setTableFilter: (id: string, filter: string) => Promise<void>;
  openTableWithFilter: (
    schema: string,
    table: string,
    filter: string,
  ) => Promise<void>;

  // --- history ---
  toggleHistory: () => void;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  rerunFromHistory: (sql: string) => void;
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
  };
}

const TABS_KEY = "cubbydb:openTabs";

// Guards against React StrictMode invoking initialize() twice on mount, which
// would open two connections and leave one orphaned.
let didInitialize = false;

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
      }),
    );
    const active = tabs[payload.activeIndex] ?? tabs[0];
    return { tabs, activeTabId: active.id };
  } catch {
    return null;
  }
}

export const useStore = create<AppStore>((set, get) => ({
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

  newTab(opts) {
    const tab = makeTab(opts);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab(id) {
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
  },

  setActiveTab(id) {
    set({ activeTabId: id });
  },

  setTabSql(id, sql) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql } : t)),
    }));
  },

  async runTab(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.running) return;

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, running: true, error: null } : t,
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
      set({ activeTabId: existing.id });
      return;
    }

    const sql = await api.selectTopSql(schema, table);
    const tab = makeTab({
      kind: "table",
      title: table,
      sql,
      source: { schema, table },
    });
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    await get().runTab(tab.id);
  },

  async openTableWithFilter(schema, table, filter) {
    // Used by FK navigation: open (or focus) the referenced table showing only
    // the matching row. Backend builds the SQL from the filter predicate.
    const sql = await api.selectTopSql(schema, table, filter.trim() || null);
    const existing = get().tabs.find(
      (t) =>
        t.kind === "table" &&
        t.source?.schema === schema &&
        t.source?.table === table,
    );
    if (existing) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === existing.id ? { ...t, sql, filter: filter.trim() || undefined } : t,
        ),
        activeTabId: existing.id,
      }));
      await get().runTab(existing.id);
      return;
    }
    const tab = makeTab({
      kind: "table",
      title: table,
      sql,
      source: { schema, table },
      filter: filter.trim() || undefined,
    });
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    await get().runTab(tab.id);
  },

  async setTableFilter(id, filter) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || !tab.source) return;
    // Regenerate the table query with the WHERE predicate in the backend.
    const sql = await api.selectTopSql(
      tab.source.schema,
      tab.source.table,
      filter.trim() || null,
    );
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, sql, filter: filter.trim() || undefined } : t,
      ),
    }));
    await get().runTab(id);
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
    const id = get().newTab({ title: "history.sql", sql });
    void get().runTab(id);
  },
}));

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
