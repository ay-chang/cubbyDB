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
  ActiveConnectionInfo,
  ColumnValue,
  ConnectionParams,
  DbError,
  HistoryEntry,
  LastConnection,
  QueryResult,
  SavedConnection,
  SavedQuery,
  SchemaNode,
} from "../types";
import { errorMessage, isDbError } from "../api/backend";

/**
 * A tab is a `query` tab (SQL editor + results), a `table` tab (results
 * only — opened by clicking a table in the tree, no editor), a `structure`
 * tab (a read-only columns/indexes/constraints view for one table), or a
 * `function`/`sequence` tab (a read-only definition/details view for one
 * function or sequence) — the latter three all opened via the schema tree's
 * context menu.
 */
export type TabKind = "query" | "table" | "structure" | "function" | "sequence";

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
  /** For `function`/`sequence` tabs: which object is being viewed. `oid`
   *  disambiguates function overloads; unused for sequences. */
  objectRef?: { schema: string; name: string; oid?: number };
  /** For `table` tabs: the current WHERE-filter predicate, if any. */
  filter?: string;
  /** For `query` tabs: which saved query (if any) this tab represents — set
   *  on first save, or when opened from the Saved Queries panel. Absent for
   *  ad-hoc, never-saved tabs. */
  savedQueryId?: string;
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

/**
 * One live database connection's whole workspace — its tabs, schema tree,
 * and identity. Several can exist at once (the "connection switcher"); only
 * one is visible at a time, chosen by `AppStore.activeConnectionId`, but
 * every slot's session stays open on the backend regardless of which is
 * visible.
 */
export interface ConnectionSlot {
  sessionId: string;
  current: ActiveConnectionInfo;
  /** The params this session was (re)connected with — kept so "edit the
   *  connection I'm on" has something to prefill from, even for an ad-hoc
   *  connection that was never saved. */
  params: ConnectionParams;
  schema: SchemaNode[];
  schemaLoading: boolean;
  schemaError: string | null;
  tabs: QueryTab[];
  activeTabId: string | null;
}

type View = "connection" | "workspace";

/** The active color theme. Persisted across launches. Each is a full
 *  surfaces/borders/text palette (see `tokens.css`) belonging to one of two
 *  families — light or dark — tracked separately by `ThemeMode` below. */
export type Theme =
  | "light"
  | "paper"
  | "dark"
  | "midnight"
  | "charcoal"
  | "slate"
  | "onedark"
  | "dracula";

/** `Theme` options in display order — light family first, then dark. */
export const THEME_OPTIONS: Theme[] = [
  "light",
  "paper",
  "dark",
  "midnight",
  "charcoal",
  "slate",
  "onedark",
  "dracula",
];

/** Whether a theme belongs to the light or dark family. Accent-color
 *  palettes (see `ACCENT_PALETTES` below) are only tuned per family, not per
 *  individual theme, so this is what picks which variant applies. */
export type ThemeMode = "light" | "dark";

export const THEME_MODE: Record<Theme, ThemeMode> = {
  light: "light",
  paper: "light",
  dark: "dark",
  midnight: "dark",
  charcoal: "dark",
  slate: "dark",
  onedark: "dark",
  dracula: "dark",
};

/** The accent color used for buttons, active states, and SQL keyword
 *  highlighting. Persisted across launches. */
export type AccentColor =
  | "indigo"
  | "blue"
  | "cyan"
  | "teal"
  | "green"
  | "amber"
  | "orange"
  | "red"
  | "pink"
  | "purple";

/** `AccentColor` options in display order. */
export const ACCENT_COLOR_OPTIONS: AccentColor[] = [
  "indigo",
  "blue",
  "cyan",
  "teal",
  "green",
  "amber",
  "orange",
  "red",
  "pink",
  "purple",
];

export const ACCENT_COLOR_LABELS: Record<AccentColor, string> = {
  indigo: "Indigo",
  blue: "Blue",
  cyan: "Cyan",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  orange: "Orange",
  red: "Red",
  pink: "Pink",
  purple: "Purple",
};

/** The longstanding default — existing users see no visual change. */
export const DEFAULT_ACCENT_COLOR: AccentColor = "indigo";

interface AccentPalette {
  accent: string;
  accentHover: string;
  accentTint: string;
  accentTintText: string;
  accentGlow: string;
  accentGlowSoft: string;
}

/** The swatch color shown for each option in the Settings picker — always the
 *  light-mode `accent` value, so swatches read consistently regardless of the
 *  active theme. */
export const ACCENT_COLOR_SWATCH: Record<AccentColor, string> = {
  indigo: "#5e6ad2",
  blue: "#3b82f6",
  cyan: "#0891b2",
  teal: "#0d9488",
  green: "#16a34a",
  amber: "#d97706",
  orange: "#ea580c",
  red: "#e11d3f",
  pink: "#db2777",
  purple: "#7c3aed",
};

/** Light/dark variants of every accent color, in the same token shape as the
 *  original indigo tokens in `tokens.css` (accent / hover / tint / tint-text /
 *  glow / glow-soft). Applied as inline CSS custom properties on `<html>`, so
 *  they override whichever theme block is active without touching the
 *  stylesheet itself. */
const ACCENT_PALETTES: Record<AccentColor, { light: AccentPalette; dark: AccentPalette }> = {
  indigo: {
    light: {
      accent: "#5e6ad2",
      accentHover: "#5460c6",
      accentTint: "#eeeffb",
      accentTintText: "#4a54b8",
      accentGlow: "rgba(94, 106, 210, 0.12)",
      accentGlowSoft: "rgba(94, 106, 210, 0.08)",
    },
    dark: {
      accent: "#6e79db",
      accentHover: "#808ae2",
      accentTint: "#21243a",
      accentTintText: "#a7aef0",
      accentGlow: "rgba(110, 121, 219, 0.22)",
      accentGlowSoft: "rgba(110, 121, 219, 0.12)",
    },
  },
  blue: {
    light: {
      accent: "#3b82f6",
      accentHover: "#2f6fe0",
      accentTint: "#eaf1fe",
      accentTintText: "#2657b0",
      accentGlow: "rgba(59, 130, 246, 0.12)",
      accentGlowSoft: "rgba(59, 130, 246, 0.08)",
    },
    dark: {
      accent: "#5b93f5",
      accentHover: "#74a4f7",
      accentTint: "#17233a",
      accentTintText: "#9dc0fb",
      accentGlow: "rgba(91, 147, 245, 0.22)",
      accentGlowSoft: "rgba(91, 147, 245, 0.12)",
    },
  },
  cyan: {
    light: {
      accent: "#0891b2",
      accentHover: "#08809c",
      accentTint: "#e6f6f9",
      accentTintText: "#0b6f86",
      accentGlow: "rgba(8, 145, 178, 0.12)",
      accentGlowSoft: "rgba(8, 145, 178, 0.08)",
    },
    dark: {
      accent: "#22b8d8",
      accentHover: "#4bcbe6",
      accentTint: "#112a30",
      accentTintText: "#7fdcee",
      accentGlow: "rgba(34, 184, 216, 0.22)",
      accentGlowSoft: "rgba(34, 184, 216, 0.12)",
    },
  },
  teal: {
    light: {
      accent: "#0d9488",
      accentHover: "#0b8377",
      accentTint: "#e6f5f3",
      accentTintText: "#0a6d63",
      accentGlow: "rgba(13, 148, 136, 0.12)",
      accentGlowSoft: "rgba(13, 148, 136, 0.08)",
    },
    dark: {
      accent: "#22b8a4",
      accentHover: "#45cab8",
      accentTint: "#0f2926",
      accentTintText: "#7de9db",
      accentGlow: "rgba(34, 184, 164, 0.22)",
      accentGlowSoft: "rgba(34, 184, 164, 0.12)",
    },
  },
  green: {
    light: {
      accent: "#16a34a",
      accentHover: "#128a3f",
      accentTint: "#e9f8ee",
      accentTintText: "#0f7a37",
      accentGlow: "rgba(22, 163, 74, 0.12)",
      accentGlowSoft: "rgba(22, 163, 74, 0.08)",
    },
    dark: {
      accent: "#34c765",
      accentHover: "#55d17e",
      accentTint: "#12291a",
      accentTintText: "#86e6a4",
      accentGlow: "rgba(52, 199, 101, 0.22)",
      accentGlowSoft: "rgba(52, 199, 101, 0.12)",
    },
  },
  amber: {
    light: {
      accent: "#d97706",
      accentHover: "#bd6605",
      accentTint: "#fdf3e3",
      accentTintText: "#9a5b09",
      accentGlow: "rgba(217, 119, 6, 0.12)",
      accentGlowSoft: "rgba(217, 119, 6, 0.08)",
    },
    dark: {
      accent: "#d99a3f",
      accentHover: "#e4ac5c",
      accentTint: "#2a2010",
      accentTintText: "#f0c37e",
      accentGlow: "rgba(217, 154, 63, 0.22)",
      accentGlowSoft: "rgba(217, 154, 63, 0.12)",
    },
  },
  orange: {
    light: {
      accent: "#ea580c",
      accentHover: "#cf4c09",
      accentTint: "#fdece1",
      accentTintText: "#ad4008",
      accentGlow: "rgba(234, 88, 12, 0.12)",
      accentGlowSoft: "rgba(234, 88, 12, 0.08)",
    },
    dark: {
      accent: "#f2793a",
      accentHover: "#f68f5a",
      accentTint: "#2c1c10",
      accentTintText: "#f7ae82",
      accentGlow: "rgba(242, 121, 58, 0.22)",
      accentGlowSoft: "rgba(242, 121, 58, 0.12)",
    },
  },
  red: {
    light: {
      accent: "#e11d3f",
      accentHover: "#c31836",
      accentTint: "#fdeaee",
      accentTintText: "#a8123a",
      accentGlow: "rgba(225, 29, 63, 0.12)",
      accentGlowSoft: "rgba(225, 29, 63, 0.08)",
    },
    dark: {
      accent: "#f0506d",
      accentHover: "#f37088",
      accentTint: "#2c1219",
      accentTintText: "#f6a0b2",
      accentGlow: "rgba(240, 80, 109, 0.22)",
      accentGlowSoft: "rgba(240, 80, 109, 0.12)",
    },
  },
  pink: {
    light: {
      accent: "#db2777",
      accentHover: "#c11f68",
      accentTint: "#fdeaf3",
      accentTintText: "#a01c62",
      accentGlow: "rgba(219, 39, 119, 0.12)",
      accentGlowSoft: "rgba(219, 39, 119, 0.08)",
    },
    dark: {
      accent: "#ef5da3",
      accentHover: "#f27fb6",
      accentTint: "#2c1521",
      accentTintText: "#f7a8ce",
      accentGlow: "rgba(239, 93, 163, 0.22)",
      accentGlowSoft: "rgba(239, 93, 163, 0.12)",
    },
  },
  purple: {
    light: {
      accent: "#7c3aed",
      accentHover: "#6c2bd9",
      accentTint: "#f1eafe",
      accentTintText: "#5b21b6",
      accentGlow: "rgba(124, 58, 237, 0.12)",
      accentGlowSoft: "rgba(124, 58, 237, 0.08)",
    },
    dark: {
      accent: "#9d6df0",
      accentHover: "#af88f3",
      accentTint: "#211a33",
      accentTintText: "#c9aefa",
      accentGlow: "rgba(157, 109, 240, 0.22)",
      accentGlowSoft: "rgba(157, 109, 240, 0.12)",
    },
  },
};

/** The results-grid data font. Persisted across launches. */
export type TableFont = "sans" | "mono" | "serif" | "system";

/** CSS font-family stacks for each `TableFont` option. */
export const TABLE_FONT_STACKS: Record<TableFont, string> = {
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
  serif: '"Iowan Old Style", Georgia, Cambria, "Times New Roman", Times, serif',
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

/** The results-grid data font size, in px. Persisted across launches. */
export type TableFontSize = number;

/** Selectable font sizes (px) offered in the Settings dropdown. */
export const TABLE_FONT_SIZE_OPTIONS: number[] = [
  10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18,
];

/** The longstanding default — existing users see no visual change. */
export const DEFAULT_TABLE_FONT_SIZE: TableFontSize = 12.5;

/** The SQL editor's font size, in px. Persisted across launches. */
export type EditorFontSize = number;

/** Selectable editor font sizes (px) offered in the Settings dropdown. */
export const EDITOR_FONT_SIZE_OPTIONS: number[] = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22,
];

/** The longstanding default — existing users see no visual change. */
export const DEFAULT_EDITOR_FONT_SIZE: EditorFontSize = 13;

/** The SQL editor's default font — unlike the table (which defaults to sans),
 *  the editor defaults to the classic code font, matching longstanding
 *  behavior. Reuses `TableFont`/`TABLE_FONT_STACKS`: same 4 named stacks, just
 *  applied through a different CSS variable. */
export const DEFAULT_EDITOR_FONT: TableFont = "mono";

/** The results-grid row height, in px. Persisted across launches. */
export type TableRowHeight = number;

/** Selectable row heights (px) offered in the Settings dropdown, with a
 *  density label for each. */
export const TABLE_ROW_HEIGHT_OPTIONS: { px: number; label: string }[] = [
  { px: 26, label: "Compact" },
  { px: 28, label: "Cozy" },
  { px: 32, label: "Comfortable" },
  { px: 36, label: "Relaxed" },
  { px: 40, label: "Spacious" },
  { px: 44, label: "Extra spacious" },
];

/** The longstanding default — existing users see no visual change. */
export const DEFAULT_TABLE_ROW_HEIGHT: TableRowHeight = 32;

/** How a SQL NULL renders in the results grid. Persisted across launches. */
export type NullDisplay = "text" | "dash" | "blank";

/** Display label for each `NullDisplay` option, in both the Settings dropdown
 *  and the grid cell itself. */
export const NULL_DISPLAY_LABELS: Record<NullDisplay, string> = {
  text: "NULL",
  dash: "—",
  blank: "",
};

/** A single-character field/value separator, used for CSV export and for
 *  copying rows to the clipboard. Persisted across launches. */
export type Delimiter = "," | "\t" | ";";

/** Display label for each `Delimiter` option in the Settings dropdowns. */
export const DELIMITER_LABELS: Record<Delimiter, string> = {
  ",": "Comma (,)",
  "\t": "Tab",
  ";": "Semicolon (;)",
};

/** `Delimiter` options in a stable, explicit display order. */
export const DELIMITER_OPTIONS: Delimiter[] = [",", "\t", ";"];

/** How many entries the History panel fetches/shows. This is a *display*
 *  limit only — it does not change the backend's on-disk retention cap. */
export const HISTORY_LIMIT_OPTIONS: number[] = [50, 100, 200, 500, 1000];
export const DEFAULT_HISTORY_LIMIT = 200;

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

  /** User-saved, named SQL queries — global, not tied to a connection. */
  savedQueries: SavedQuery[];
  savedQueriesOpen: boolean;

  /** Every live connection's workspace, keyed by session id. */
  connections: Record<string, ConnectionSlot>;
  /** Which connection's workspace is currently visible. */
  activeConnectionId: string | null;

  history: HistoryEntry[];
  historyOpen: boolean;

  /** Cmd/Ctrl+K quick-jump: search tables and columns in the active
   *  connection's schema. */
  commandPaletteOpen: boolean;
  /** A one-shot request for `TableStructurePane` to scroll to and flash a
   *  specific column, set by jumping to it from the command palette. Keyed
   *  by a `nonce` so re-jumping to the same column still re-triggers the
   *  effect; cleared once consumed. */
  pendingColumnHighlight: { schema: string; table: string; column: string; nonce: number } | null;

  /** When set, a "leave without saving?" confirmation is shown. */
  confirmDialog: ConfirmDialogState | null;

  /** Active color theme, applied to the document root. */
  theme: Theme;
  /** Active accent color, applied to the document root. */
  accentColor: AccentColor;
  /** Results-grid data font, applied to the document root. */
  tableFont: TableFont;
  /** Results-grid data font size, applied to the document root. */
  tableFontSize: TableFontSize;
  /** Results-grid row height, applied to the document root. */
  tableRowHeight: TableRowHeight;
  /** Whether alternating results-grid rows are tinted. */
  tableZebra: boolean;
  /** Whether the results grid shows row/cell divider lines. */
  tableCellBorders: boolean;
  /** Whether the results-grid column-header row is shaded slightly darker,
   *  so it stands out more from the data rows below. */
  tableHeaderShade: boolean;
  /** Whether long cell text wraps instead of truncating with an ellipsis. */
  tableWrapText: boolean;
  /** How SQL NULL renders in results-grid cells. */
  nullDisplay: NullDisplay;
  /** SQL editor font, applied to the document root. */
  editorFont: TableFont;
  /** SQL editor font size, applied to the document root. */
  editorFontSize: EditorFontSize;
  /** Whether long lines wrap in the SQL editor instead of scrolling. */
  editorLineWrap: boolean;
  /** Whether the top bar hides the connection's Postgres-version subtext. */
  compactTopBar: boolean;
  /** Whether previously open tabs are restored on launch. */
  restoreTabsOnLaunch: boolean;
  /** Placeholder SQL for new query tabs. */
  starterSql: string;
  /** Whether the schema tree refreshes automatically after connecting. */
  autoRefreshSchema: boolean;
  /** How many entries the History panel fetches/shows. */
  historyLimit: number;
  /** Field separator used for CSV export. */
  csvDelimiter: Delimiter;
  /** Field separator used when copying rows to the clipboard. */
  rowCopyDelimiter: Delimiter;
  /** True while the settings modal is open. */
  settingsOpen: boolean;

  // --- lifecycle ---
  initialize: () => Promise<void>;
  loadSavedConnections: () => Promise<void>;
  loadSavedQueries: () => Promise<void>;
  toggleSavedQueries: () => void;
  /** Save (or update) the active tab's SQL as a named saved query. `mode`
   *  "update" overwrites the tab's already-linked saved query (falls back to
   *  creating a new one if it isn't linked to one yet); "new" always creates
   *  a separate record, leaving any existing link untouched — the same
   *  Update/Save-as-new split saved connections use. */
  saveTabAsQuery: (tabId: string, name: string, mode: "update" | "new") => Promise<void>;
  /** Open (or focus) a saved query in a new/existing tab. */
  openSavedQuery: (query: SavedQuery) => Promise<void>;
  deleteSavedQueryById: (id: string) => Promise<void>;
  /** Rename a saved query in place (its SQL is untouched) — the Saved
   *  Queries panel's inline "✎" rename. */
  renameSavedQuery: (id: string, name: string) => Promise<void>;
  /** Open a new connection and add it as a slot — never replaces an
   *  existing one, so connecting to a second database leaves the first
   *  live. Becomes the active (visible) slot. */
  connectTo: (
    connection: Pick<SavedConnection, "params" | "name"> & { id?: string },
  ) => Promise<void>;
  /** Close one connection (defaults to the active one). If others remain
   *  open, the view stays on the workspace, switched to one of them. */
  disconnect: (sessionId?: string) => Promise<void>;
  /** Switch which already-open connection's workspace is visible. No
   *  backend call — every open connection stays live regardless. */
  switchConnection: (sessionId: string) => void;
  /** Reflect a saved connection's new name onto any live session that was
   *  opened from it, so a rename shows up in the connection switcher
   *  immediately rather than only after reconnecting. A no-op if that saved
   *  connection isn't currently connected. */
  renameLiveConnection: (savedConnectionId: string, name: string) => void;
  /** Re-establish an already-open session with edited params/name — for
   *  "edit the connection I'm on," not opening an additional one. Keeps the
   *  same slot (tabs stay put); its schema is cleared since it may now point
   *  at a different database. */
  reconnectSession: (
    sessionId: string,
    connection: Pick<SavedConnection, "params" | "name"> & { id?: string },
  ) => Promise<void>;

  // --- schema ---
  /** Defaults to the active connection when `connectionId` is omitted. */
  refreshSchema: (connectionId?: string) => Promise<void>;

  // --- tabs ---
  newTab: (opts?: { title?: string; sql?: string }) => Promise<string>;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  setTabSql: (id: string, sql: string) => void;
  /** Run a tab's query. `sqlOverride`, if given, is sent to the backend
   *  instead of the tab's own `sql` (e.g. just the statement under the
   *  cursor, or a selection) — the tab's editor buffer is never changed by
   *  this, only what gets executed and logged to history. */
  runTab: (id: string, sqlOverride?: string) => Promise<void>;
  /** Ask the server to interrupt whatever's running on the active
   *  connection (one query executing at a time per connection) — whichever
   *  tab's `runTab` call is actually in flight there will see the resulting
   *  "canceling statement due to user request" error through its normal
   *  error handling; no tab-specific bookkeeping needed here. A background
   *  (non-visible) connection's query isn't affected. */
  cancelQuery: () => void;
  openSelectTop: (schema: string, table: string) => Promise<void>;
  /** Open (or focus) a read-only "structure" tab for a table — columns,
   *  indexes, and check constraints. No query is run; `TableStructurePane`
   *  fetches its own data once the tab is open. */
  openTableStructure: (schema: string, table: string) => Promise<void>;
  /** Open (or focus) a table's structure tab, then flag a specific column
   *  for `TableStructurePane` to scroll to and briefly highlight — the
   *  command palette's "jump to column" action. */
  jumpToColumn: (schema: string, table: string, column: string) => Promise<void>;
  clearPendingColumnHighlight: () => void;
  /** Open (or focus) a read-only "function" tab for one function/procedure —
   *  its body is fetched separately by `FunctionDefinitionPane`. `oid`
   *  disambiguates overloads. */
  openFunctionDefinition: (schema: string, oid: number, name: string) => Promise<void>;
  /** Open (or focus) a read-only "sequence" tab for one sequence — its
   *  current value/config is fetched separately by `SequenceDetailsPane`. */
  openSequenceDetails: (schema: string, name: string) => Promise<void>;
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
  /** Show an error in the same banner as a failed insert/update/delete — used
   *  for things that aren't a database error but belong in the same "why
   *  didn't my last data change work" slot (e.g. a malformed CSV import). */
  setUpdateError: (tabId: string, error: DbError) => void;

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

  // --- command palette ---
  toggleCommandPalette: () => void;
  closeCommandPalette: () => void;

  // --- appearance / settings ---
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccentColor: (color: AccentColor) => void;
  setTableFont: (font: TableFont) => void;
  setTableFontSize: (size: TableFontSize) => void;
  setTableRowHeight: (height: TableRowHeight) => void;
  setTableZebra: (enabled: boolean) => void;
  setTableCellBorders: (enabled: boolean) => void;
  setTableHeaderShade: (enabled: boolean) => void;
  setTableWrapText: (enabled: boolean) => void;
  setNullDisplay: (display: NullDisplay) => void;
  setEditorFont: (font: TableFont) => void;
  setEditorFontSize: (size: EditorFontSize) => void;
  setEditorLineWrap: (enabled: boolean) => void;
  setCompactTopBar: (enabled: boolean) => void;
  setRestoreTabsOnLaunch: (enabled: boolean) => void;
  setStarterSql: (sql: string) => void;
  setAutoRefreshSchema: (enabled: boolean) => void;
  setHistoryLimit: (limit: number) => void;
  setCsvDelimiter: (delimiter: Delimiter) => void;
  setRowCopyDelimiter: (delimiter: Delimiter) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

/** The default new-query-tab placeholder — user-editable in Settings >
 *  General. */
export const DEFAULT_STARTER_SQL =
  "-- Write SQL here, then press Cmd/Ctrl+Enter to run.\nSELECT 1;\n";

function makeTab(opts?: {
  title?: string;
  sql?: string;
  kind?: TabKind;
  source?: { schema: string; table: string };
  objectRef?: { schema: string; name: string; oid?: number };
  filter?: string;
  page?: number;
  savedQueryId?: string;
}): QueryTab {
  return {
    id: nextTabId(),
    kind: opts?.kind ?? "query",
    title: opts?.title ?? "untitled.sql",
    sql: opts?.sql ?? DEFAULT_STARTER_SQL,
    result: null,
    error: null,
    running: false,
    hasRun: false,
    source: opts?.source,
    objectRef: opts?.objectRef,
    filter: opts?.filter,
    page: opts?.page,
    savedQueryId: opts?.savedQueryId,
  };
}

const TABS_KEY = "cubbydb:openTabs";
const THEME_KEY = "cubbydb:theme";
const ACCENT_COLOR_KEY = "cubbydb:accentColor";
const TABLE_FONT_KEY = "cubbydb:tableFont";
const TABLE_FONT_SIZE_KEY = "cubbydb:tableFontSize";
const TABLE_ROW_HEIGHT_KEY = "cubbydb:tableRowHeight";
const TABLE_ZEBRA_KEY = "cubbydb:tableZebra";
const TABLE_CELL_BORDERS_KEY = "cubbydb:tableCellBorders";
const TABLE_HEADER_SHADE_KEY = "cubbydb:tableHeaderShade";
const TABLE_WRAP_TEXT_KEY = "cubbydb:tableWrapText";
const NULL_DISPLAY_KEY = "cubbydb:nullDisplay";
const EDITOR_FONT_KEY = "cubbydb:editorFont";
const EDITOR_FONT_SIZE_KEY = "cubbydb:editorFontSize";
const EDITOR_LINE_WRAP_KEY = "cubbydb:editorLineWrap";
const COMPACT_TOP_BAR_KEY = "cubbydb:compactTopBar";
const RESTORE_TABS_KEY = "cubbydb:restoreTabsOnLaunch";
const STARTER_SQL_KEY = "cubbydb:starterSql";
const AUTO_REFRESH_SCHEMA_KEY = "cubbydb:autoRefreshSchema";
const HISTORY_LIMIT_KEY = "cubbydb:historyLimit";
const CSV_DELIMITER_KEY = "cubbydb:csvDelimiter";
const ROW_COPY_DELIMITER_KEY = "cubbydb:rowCopyDelimiter";

/** Read the saved theme, defaulting to light. */
function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved && (THEME_OPTIONS as string[]).includes(saved) ? (saved as Theme) : "light";
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

/** Read the saved accent color, defaulting to indigo. */
function loadAccentColor(): AccentColor {
  try {
    const saved = localStorage.getItem(ACCENT_COLOR_KEY);
    return saved && (ACCENT_COLOR_OPTIONS as string[]).includes(saved)
      ? (saved as AccentColor)
      : DEFAULT_ACCENT_COLOR;
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}

/** Reflect the accent color onto the accent-family CSS variables (for the
 *  given theme's light/dark family) and persist it. Re-run with the new theme
 *  whenever the theme itself changes, since every accent color carries
 *  distinct light/dark variants (not one per individual theme — Paper reuses
 *  Light's family, Midnight/Charcoal/Slate reuse Dark's). */
function applyAccentColor(color: AccentColor, theme: Theme) {
  const palette = ACCENT_PALETTES[color][THEME_MODE[theme]];
  try {
    const root = document.documentElement.style;
    root.setProperty("--accent", palette.accent);
    root.setProperty("--accent-hover", palette.accentHover);
    root.setProperty("--accent-tint", palette.accentTint);
    root.setProperty("--accent-tint-text", palette.accentTintText);
    root.setProperty("--accent-glow", palette.accentGlow);
    root.setProperty("--accent-glow-soft", palette.accentGlowSoft);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(ACCENT_COLOR_KEY, color);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved table font, defaulting to the app's sans stack. */
function loadTableFont(): TableFont {
  try {
    const saved = localStorage.getItem(TABLE_FONT_KEY);
    return saved && saved in TABLE_FONT_STACKS ? (saved as TableFont) : "sans";
  } catch {
    return "sans";
  }
}

/** Reflect the table font onto the `--table-font` CSS variable and persist it. */
function applyTableFont(font: TableFont) {
  try {
    document.documentElement.style.setProperty("--table-font", TABLE_FONT_STACKS[font]);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_FONT_KEY, font);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved table font size (px), defaulting to the standard size. */
function loadTableFontSize(): TableFontSize {
  try {
    const saved = parseFloat(localStorage.getItem(TABLE_FONT_SIZE_KEY) ?? "");
    return Number.isFinite(saved) ? saved : DEFAULT_TABLE_FONT_SIZE;
  } catch {
    return DEFAULT_TABLE_FONT_SIZE;
  }
}

/** Reflect the table font size onto the `--table-font-size` CSS variable and
 *  persist it. */
function applyTableFontSize(size: TableFontSize) {
  try {
    document.documentElement.style.setProperty("--table-font-size", `${size}px`);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_FONT_SIZE_KEY, String(size));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved row height (px), defaulting to the standard height. */
function loadTableRowHeight(): TableRowHeight {
  try {
    const saved = parseFloat(localStorage.getItem(TABLE_ROW_HEIGHT_KEY) ?? "");
    return Number.isFinite(saved) ? saved : DEFAULT_TABLE_ROW_HEIGHT;
  } catch {
    return DEFAULT_TABLE_ROW_HEIGHT;
  }
}

/** Reflect the row height onto the `--h-grid-row` CSS variable and persist it. */
function applyTableRowHeight(height: TableRowHeight) {
  try {
    document.documentElement.style.setProperty("--h-grid-row", `${height}px`);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_ROW_HEIGHT_KEY, String(height));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved zebra-striping preference, defaulting to on. */
function loadTableZebra(): boolean {
  try {
    return localStorage.getItem(TABLE_ZEBRA_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Reflect zebra striping onto the `--table-zebra` CSS variable and persist
 *  it. Off swaps the stripe color for the base row background, so alternating
 *  rows blend in rather than needing the row markup itself to change. */
function applyTableZebra(enabled: boolean) {
  try {
    document.documentElement.style.setProperty(
      "--table-zebra",
      enabled ? "var(--surface-raised)" : "var(--surface)",
    );
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_ZEBRA_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved gridlines preference, defaulting to on. */
function loadTableCellBorders(): boolean {
  try {
    return localStorage.getItem(TABLE_CELL_BORDERS_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Reflect gridlines onto the `--table-border-row`/`--table-border-cell` CSS
 *  variables and persist it. Off makes both transparent. */
function applyTableCellBorders(enabled: boolean) {
  try {
    document.documentElement.style.setProperty(
      "--table-border-row",
      enabled ? "var(--border-row)" : "transparent",
    );
    document.documentElement.style.setProperty(
      "--table-border-cell",
      enabled ? "var(--border-cell)" : "transparent",
    );
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_CELL_BORDERS_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved header-shade preference, defaulting to off (existing users
 *  see no visual change). */
function loadTableHeaderShade(): boolean {
  try {
    return localStorage.getItem(TABLE_HEADER_SHADE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Reflect header-shading onto the `--table-head-shade` CSS variable (a 0-1
 *  alpha `.grid__head` blends a black wash at) and persist it. A flat alpha
 *  works the same way in every theme — light or dark — unlike a fixed color,
 *  which would need its own tuned value per theme. */
function applyTableHeaderShade(enabled: boolean) {
  try {
    document.documentElement.style.setProperty(
      "--table-head-shade",
      enabled ? "0.1" : "0",
    );
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_HEADER_SHADE_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved wrap-text preference, defaulting to off (truncate). */
function loadTableWrapText(): boolean {
  try {
    return localStorage.getItem(TABLE_WRAP_TEXT_KEY) === "true";
  } catch {
    return false;
  }
}

/** Reflect wrap-text onto the `--table-white-space`/`--table-cell-overflow`
 *  CSS variables and persist it. Wrapping also switches overflow to visible so
 *  the row (a CSS grid track with no fixed height) can grow to fit. */
function applyTableWrapText(enabled: boolean) {
  try {
    document.documentElement.style.setProperty(
      "--table-white-space",
      enabled ? "normal" : "nowrap",
    );
    document.documentElement.style.setProperty(
      "--table-cell-overflow",
      enabled ? "visible" : "hidden",
    );
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(TABLE_WRAP_TEXT_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved NULL display style, defaulting to the literal "NULL" text. */
function loadNullDisplay(): NullDisplay {
  try {
    const saved = localStorage.getItem(NULL_DISPLAY_KEY);
    return saved && saved in NULL_DISPLAY_LABELS ? (saved as NullDisplay) : "text";
  } catch {
    return "text";
  }
}

/** Persist the NULL display style. Purely a store value read directly by the
 *  grid's render logic — no CSS variable involved. */
function saveNullDisplay(display: NullDisplay) {
  try {
    localStorage.setItem(NULL_DISPLAY_KEY, display);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved editor font, defaulting to the classic code (mono) stack. */
function loadEditorFont(): TableFont {
  try {
    const saved = localStorage.getItem(EDITOR_FONT_KEY);
    return saved && saved in TABLE_FONT_STACKS
      ? (saved as TableFont)
      : DEFAULT_EDITOR_FONT;
  } catch {
    return DEFAULT_EDITOR_FONT;
  }
}

/** Reflect the editor font onto the `--editor-font` CSS variable and persist
 *  it. */
function applyEditorFont(font: TableFont) {
  try {
    document.documentElement.style.setProperty("--editor-font", TABLE_FONT_STACKS[font]);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(EDITOR_FONT_KEY, font);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved editor font size (px), defaulting to the standard size. */
function loadEditorFontSize(): EditorFontSize {
  try {
    const saved = parseFloat(localStorage.getItem(EDITOR_FONT_SIZE_KEY) ?? "");
    return Number.isFinite(saved) ? saved : DEFAULT_EDITOR_FONT_SIZE;
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

/** Reflect the editor font size onto the `--editor-font-size` CSS variable and
 *  persist it. */
function applyEditorFontSize(size: EditorFontSize) {
  try {
    document.documentElement.style.setProperty("--editor-font-size", `${size}px`);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(size));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved editor line-wrap preference, defaulting to off (scroll). */
function loadEditorLineWrap(): boolean {
  try {
    return localStorage.getItem(EDITOR_LINE_WRAP_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the editor line-wrap preference. Consumed directly by `SqlEditor`
 *  (it swaps in the CodeMirror `lineWrapping` extension) — no CSS involved. */
function saveEditorLineWrap(enabled: boolean) {
  try {
    localStorage.setItem(EDITOR_LINE_WRAP_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved compact-top-bar preference, defaulting to off. */
function loadCompactTopBar(): boolean {
  try {
    return localStorage.getItem(COMPACT_TOP_BAR_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the compact-top-bar preference. Consumed directly by `TopBar` — no
 *  CSS involved. */
function saveCompactTopBar(enabled: boolean) {
  try {
    localStorage.setItem(COMPACT_TOP_BAR_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved restore-tabs-on-launch preference, defaulting to on. */
function loadRestoreTabsOnLaunch(): boolean {
  try {
    return localStorage.getItem(RESTORE_TABS_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveRestoreTabsOnLaunch(enabled: boolean) {
  try {
    localStorage.setItem(RESTORE_TABS_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved starter-SQL template, defaulting to the built-in one. */
function loadStarterSql(): string {
  try {
    return localStorage.getItem(STARTER_SQL_KEY) ?? DEFAULT_STARTER_SQL;
  } catch {
    return DEFAULT_STARTER_SQL;
  }
}

function saveStarterSql(sql: string) {
  try {
    localStorage.setItem(STARTER_SQL_KEY, sql);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved auto-refresh-schema preference, defaulting to on. */
function loadAutoRefreshSchema(): boolean {
  try {
    return localStorage.getItem(AUTO_REFRESH_SCHEMA_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveAutoRefreshSchema(enabled: boolean) {
  try {
    localStorage.setItem(AUTO_REFRESH_SCHEMA_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read the saved History-panel fetch limit, defaulting to 200. */
function loadHistoryLimit(): number {
  try {
    const saved = parseInt(localStorage.getItem(HISTORY_LIMIT_KEY) ?? "", 10);
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_HISTORY_LIMIT;
  } catch {
    return DEFAULT_HISTORY_LIMIT;
  }
}

function saveHistoryLimit(limit: number) {
  try {
    localStorage.setItem(HISTORY_LIMIT_KEY, String(limit));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Read a saved delimiter preference from the given key, falling back to
 *  `fallback` if unset or invalid. */
function loadDelimiter(key: string, fallback: Delimiter): Delimiter {
  try {
    const saved = localStorage.getItem(key);
    return saved && saved in DELIMITER_LABELS ? (saved as Delimiter) : fallback;
  } catch {
    return fallback;
  }
}

function saveDelimiter(key: string, delimiter: Delimiter) {
  try {
    localStorage.setItem(key, delimiter);
  } catch {
    // Storage unavailable — non-fatal.
  }
}

// Apply the persisted theme/table font/font size/row height/zebra/borders/wrap
// /editor font/editor size as early as possible (on module load) so there's no
// flash of the wrong appearance before the store mounts.
applyTheme(loadTheme());
applyAccentColor(loadAccentColor(), loadTheme());
applyTableFont(loadTableFont());
applyTableFontSize(loadTableFontSize());
applyTableRowHeight(loadTableRowHeight());
applyTableZebra(loadTableZebra());
applyTableCellBorders(loadTableCellBorders());
applyTableHeaderShade(loadTableHeaderShade());
applyTableWrapText(loadTableWrapText());
applyEditorFont(loadEditorFont());
applyEditorFontSize(loadEditorFontSize());

// Guards against React StrictMode invoking initialize() twice on mount, which
// would open two connections and leave one orphaned.
let didInitialize = false;

/** Build a table-browser query for a given page (backend owns the SQL). */
function tableSql(
  sessionId: string,
  schema: string,
  table: string,
  filter: string | null,
  page: number,
): Promise<string> {
  return api.selectTopSql(sessionId, schema, table, filter, PAGE_SIZE, page * PAGE_SIZE);
}

/** Locate which connection owns a given tab id (tabs are only ever looked up
 *  by id from components, never by connection, so most tab actions address
 *  their target this way rather than assuming "the active connection" —
 *  correct even if the user switches connections while e.g. a query is
 *  still running in a background one). */
function findTabOwner(
  connections: Record<string, ConnectionSlot>,
  tabId: string,
): { connectionId: string; slot: ConnectionSlot; tab: QueryTab } | null {
  for (const connectionId of Object.keys(connections)) {
    const slot = connections[connectionId];
    const tab = slot.tabs.find((t) => t.id === tabId);
    if (tab) return { connectionId, slot, tab };
  }
  return null;
}

/** Shallow-patch one connection slot, leaving the map untouched if that
 *  connection no longer exists (e.g. it was disconnected mid-flight). */
function patchSlot(
  connections: Record<string, ConnectionSlot>,
  connectionId: string,
  patch: Partial<ConnectionSlot> | ((slot: ConnectionSlot) => Partial<ConnectionSlot>),
): Record<string, ConnectionSlot> {
  const slot = connections[connectionId];
  if (!slot) return connections;
  const p = typeof patch === "function" ? patch(slot) : patch;
  return { ...connections, [connectionId]: { ...slot, ...p } };
}

/** Patch one connection slot's `tabs` array specifically — the overwhelming
 *  majority of tab actions only ever touch this one field. */
function mapSlotTabs(
  connections: Record<string, ConnectionSlot>,
  connectionId: string,
  mapper: (tabs: QueryTab[]) => QueryTab[],
): Record<string, ConnectionSlot> {
  return patchSlot(connections, connectionId, (slot) => ({ tabs: mapper(slot.tabs) }));
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
        objectRef: t.objectRef,
        filter: t.filter,
        page: t.page,
        savedQueryId: t.savedQueryId,
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
        objectRef: t.objectRef,
        filter: t.filter,
        page: t.page,
        savedQueryId: t.savedQueryId,
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
   * Change a connection's active tab, first confirming if its current tab
   * has unsaved cell edits. Returns whether the switch actually happened.
   * Takes an explicit `connectionId` (rather than assuming "the active
   * connection") so callers that already resolved a specific slot — e.g. via
   * `findTabOwner` — stay correct even if the visible connection changes
   * mid-await.
   */
  async function switchActiveTab(connectionId: string, newId: string): Promise<boolean> {
    const slot = get().connections[connectionId];
    if (!slot) return false;
    const current = slot.tabs.find((t) => t.id === slot.activeTabId);
    if (current && current.id !== newId && tabHasPendingEdits(current)) {
      const ok = await requestConfirm(
        `"${current.title}" has unsaved changes. Leave without saving?`,
        "Leave",
      );
      if (!ok) return false;
      // Confirming "Leave" means abandoning the edits — clear them so the tab
      // is clean if the user comes back, rather than silently retaining them.
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) =>
            t.id === current.id ? { ...t, pendingEdits: {}, updateError: null } : t,
          ),
        ),
      }));
    }
    set((s) => ({ connections: patchSlot(s.connections, connectionId, { activeTabId: newId }) }));
    return true;
  }

  return {
    view: "connection",
    reconnecting: true,
    lastConnection: null,
    reconnectError: null,
    savedConnections: [],
    savedQueries: [],
    savedQueriesOpen: false,
    connections: {},
    activeConnectionId: null,
    history: [],
    historyOpen: false,
    commandPaletteOpen: false,
    pendingColumnHighlight: null,
    confirmDialog: null,
    theme: loadTheme(),
    accentColor: loadAccentColor(),
    tableFont: loadTableFont(),
    tableFontSize: loadTableFontSize(),
    tableRowHeight: loadTableRowHeight(),
    tableZebra: loadTableZebra(),
    tableCellBorders: loadTableCellBorders(),
    tableHeaderShade: loadTableHeaderShade(),
    tableWrapText: loadTableWrapText(),
    nullDisplay: loadNullDisplay(),
    editorFont: loadEditorFont(),
    editorFontSize: loadEditorFontSize(),
    editorLineWrap: loadEditorLineWrap(),
    compactTopBar: loadCompactTopBar(),
    restoreTabsOnLaunch: loadRestoreTabsOnLaunch(),
    starterSql: loadStarterSql(),
    autoRefreshSchema: loadAutoRefreshSchema(),
    historyLimit: loadHistoryLimit(),
    csvDelimiter: loadDelimiter(CSV_DELIMITER_KEY, ","),
    rowCopyDelimiter: loadDelimiter(ROW_COPY_DELIMITER_KEY, "\t"),
    settingsOpen: false,

    async initialize() {
      if (didInitialize) return;
      didInitialize = true;

      await get().loadSavedConnections();
      await get().loadSavedQueries();

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

        // Restore the tabs that were open last time (without their stale
        // results), unless the user has opted out. Only this one
        // auto-restored connection gets its tabs restored — connections
        // added manually during a session always start with one blank tab
        // and don't persist across a restart.
        const connectionId = get().activeConnectionId;
        if (connectionId && get().restoreTabsOnLaunch) {
          const restored = loadPersistedTabs();
          if (restored) {
            set((s) => ({
              connections: patchSlot(s.connections, connectionId, {
                tabs: restored.tabs,
                activeTabId: restored.activeTabId,
              }),
            }));
            // Re-populate restored table tabs (they hold their select-top SQL
            // but no results yet), one at a time. Query tabs keep their SQL
            // and wait for the user to run.
            for (const tab of get().connections[connectionId]?.tabs ?? []) {
              if (tab.kind === "table" && !tab.result && !tab.error && !tab.running) {
                await get().runTab(tab.id);
              }
            }
          }
        }
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

    async loadSavedQueries() {
      try {
        const saved = await api.listSavedQueries();
        set({ savedQueries: saved });
      } catch (err) {
        // Non-fatal: the panel just shows empty until the next successful load.
        console.error("failed to load saved queries:", errorMessage(err));
      }
    },

    async connectTo(connection) {
      const info = await api.connect(connection.params, connection.name, connection.id ?? null);
      const tab = makeTab({ sql: get().starterSql });
      const slot: ConnectionSlot = {
        sessionId: info.sessionId,
        current: info,
        params: connection.params,
        schema: [],
        schemaLoading: false,
        schemaError: null,
        tabs: [tab],
        activeTabId: tab.id,
      };
      set((s) => ({
        view: "workspace",
        connections: { ...s.connections, [info.sessionId]: slot },
        activeConnectionId: info.sessionId,
      }));

      if (get().autoRefreshSchema) await get().refreshSchema();
    },

    async disconnect(sessionId) {
      const id = sessionId ?? get().activeConnectionId;
      if (!id) return;
      try {
        await api.disconnect(id);
      } finally {
        set((s) => {
          const connections = { ...s.connections };
          delete connections[id];
          const remainingIds = Object.keys(connections);
          const activeConnectionId =
            s.activeConnectionId === id
              ? (remainingIds[0] ?? null)
              : s.activeConnectionId;
          return {
            connections,
            activeConnectionId,
            view: remainingIds.length > 0 ? "workspace" : "connection",
            historyOpen: remainingIds.length > 0 ? s.historyOpen : false,
          };
        });
      }
    },

    switchConnection(sessionId) {
      if (!get().connections[sessionId]) return;
      set({ activeConnectionId: sessionId });
    },

    renameLiveConnection(savedConnectionId, name) {
      set((s) => {
        const entry = Object.entries(s.connections).find(
          ([, slot]) => slot.current.connectionId === savedConnectionId,
        );
        if (!entry) return s;
        const [sessionId, slot] = entry;
        return {
          connections: {
            ...s.connections,
            [sessionId]: { ...slot, current: { ...slot.current, name } },
          },
        };
      });
    },

    async reconnectSession(sessionId, connection) {
      if (!get().connections[sessionId]) return;
      const info = await api.reconnectSession(
        sessionId,
        connection.params,
        connection.name,
        connection.id ?? null,
      );
      set((s) => ({
        connections: patchSlot(s.connections, sessionId, {
          current: info,
          params: connection.params,
          // The schema tree may now describe an entirely different
          // database — drop it rather than show stale/wrong tables.
          schema: [],
          schemaError: null,
        }),
      }));
      if (get().autoRefreshSchema) await get().refreshSchema(sessionId);
    },

    async refreshSchema(connectionId) {
      const id = connectionId ?? get().activeConnectionId;
      if (!id) return;
      set((s) => ({
        connections: patchSlot(s.connections, id, {
          schemaLoading: true,
          schemaError: null,
        }),
      }));
      try {
        const slot = get().connections[id];
        if (!slot) return;
        const schema = await api.fetchSchema(slot.sessionId);
        set((s) => ({
          connections: patchSlot(s.connections, id, { schema, schemaLoading: false }),
        }));
      } catch (err) {
        set((s) => ({
          connections: patchSlot(s.connections, id, {
            schemaLoading: false,
            schemaError: errorMessage(err),
          }),
        }));
      }
    },

    async newTab(opts) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return "";
      const tab = makeTab({ ...opts, sql: opts?.sql ?? get().starterSql });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      await switchActiveTab(connectionId, tab.id);
      return tab.id;
    },

    closeTab(id) {
      const owner = findTabOwner(get().connections, id);
      if (!owner) return;
      const { connectionId, tab } = owner;

      const doClose = () => {
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, (slot) => {
            const idx = slot.tabs.findIndex((t) => t.id === id);
            if (idx === -1) return {};
            const tabs = slot.tabs.filter((t) => t.id !== id);
            let activeTabId = slot.activeTabId;
            if (activeTabId === id) {
              const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
              activeTabId = neighbor ? neighbor.id : null;
            }
            return { tabs, activeTabId };
          }),
        }));
      };

      if (tabHasPendingEdits(tab)) {
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
      const owner = findTabOwner(get().connections, id);
      if (!owner || id === owner.slot.activeTabId) return;
      void switchActiveTab(owner.connectionId, id);
    },

    reorderTab(fromIndex, toIndex) {
      set((s) => {
        const connectionId = s.activeConnectionId;
        if (!connectionId) return s;
        return {
          connections: patchSlot(s.connections, connectionId, (slot) => {
            if (
              fromIndex === toIndex ||
              fromIndex < 0 ||
              toIndex < 0 ||
              fromIndex >= slot.tabs.length ||
              toIndex >= slot.tabs.length
            ) {
              return {};
            }
            const tabs = [...slot.tabs];
            const [moved] = tabs.splice(fromIndex, 1);
            tabs.splice(toIndex, 0, moved);
            return { tabs };
          }),
        };
      });
    },

    setTabSql(id, sql) {
      set((s) => {
        const owner = findTabOwner(s.connections, id);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => (t.id === id ? { ...t, sql } : t)),
          ),
        };
      });
    },

    async runTab(id, sqlOverride) {
      const owner = findTabOwner(get().connections, id);
      if (!owner || owner.tab.running) return;
      const { connectionId, tab } = owner;
      const sqlToRun = sqlOverride ?? tab.sql;

      if (tabHasPendingEdits(tab)) {
        const ok = await requestConfirm(
          `"${tab.title}" has unsaved changes. Refresh and lose them?`,
          "Refresh",
        );
        if (!ok) return;
      }

      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) =>
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
        ),
      }));

      // Re-resolve the slot after marking running — it's still there unless
      // this connection was disconnected in the meantime.
      const slot = get().connections[connectionId];
      if (!slot) return;

      try {
        const result = await api.runQuery(slot.sessionId, sqlToRun);
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === id
                ? { ...t, running: false, hasRun: true, result, error: null }
                : t,
            ),
          ),
        }));
      } catch (err) {
        const dbError: DbError = isDbError(err)
          ? err
          : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === id
                ? { ...t, running: false, hasRun: true, error: dbError }
                : t,
            ),
          ),
        }));
      } finally {
        // Reflect the just-logged query in the history panel if it's open.
        if (get().historyOpen) void get().refreshHistory();
      }
    },

    cancelQuery() {
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      if (!slot) return;
      void api.cancelQuery(slot.sessionId).catch((err) => {
        console.error("failed to cancel query:", errorMessage(err));
      });
    },

    async openSelectTop(schema, table) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      // If this table is already open, just focus its tab.
      const existing = slot.tabs.find(
        (t) =>
          t.kind === "table" &&
          t.source?.schema === schema &&
          t.source?.table === table,
      );
      if (existing) {
        await switchActiveTab(connectionId, existing.id);
        return;
      }

      const sql = await tableSql(slot.sessionId, schema, table, null, 0);
      const tab = makeTab({
        kind: "table",
        title: table,
        sql,
        source: { schema, table },
        page: 0,
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        // The user chose to stay on the current (dirty) tab — remove the tab
        // we speculatively created rather than leaving an unopened orphan.
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
        return;
      }
      await get().runTab(tab.id);
    },

    async openTableStructure(schema, table) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      const existing = slot.tabs.find(
        (t) =>
          t.kind === "structure" &&
          t.source?.schema === schema &&
          t.source?.table === table,
      );
      if (existing) {
        await switchActiveTab(connectionId, existing.id);
        return;
      }

      const tab = makeTab({
        kind: "structure",
        title: `${table} (structure)`,
        source: { schema, table },
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
      }
    },

    async openFunctionDefinition(schema, oid, name) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      const existing = slot.tabs.find(
        (t) => t.kind === "function" && t.objectRef?.oid === oid,
      );
      if (existing) {
        await switchActiveTab(connectionId, existing.id);
        return;
      }

      const tab = makeTab({
        kind: "function",
        title: `${name}()`,
        objectRef: { schema, name, oid },
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
      }
    },

    async openSequenceDetails(schema, name) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      const existing = slot.tabs.find(
        (t) =>
          t.kind === "sequence" &&
          t.objectRef?.schema === schema &&
          t.objectRef?.name === name,
      );
      if (existing) {
        await switchActiveTab(connectionId, existing.id);
        return;
      }

      const tab = makeTab({
        kind: "sequence",
        title: name,
        objectRef: { schema, name },
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
      }
    },

    async jumpToColumn(schema, table, column) {
      await get().openTableStructure(schema, table);
      // Only flag the highlight if we actually landed on that structure tab
      // — openTableStructure can no-op if the user declined to leave a
      // dirty tab, and we don't want a stale highlight firing later.
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      const activeTab = slot?.tabs.find((t) => t.id === slot.activeTabId);
      if (
        activeTab?.kind === "structure" &&
        activeTab.source?.schema === schema &&
        activeTab.source?.table === table
      ) {
        set({ pendingColumnHighlight: { schema, table, column, nonce: Date.now() } });
      }
    },

    clearPendingColumnHighlight() {
      set({ pendingColumnHighlight: null });
    },

    async openTableWithFilter(schema, table, filter) {
      // Used by FK navigation: open (or focus) the referenced table showing only
      // the matching row. Backend builds the SQL from the filter predicate.
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      const existing = slot.tabs.find(
        (t) =>
          t.kind === "table" &&
          t.source?.schema === schema &&
          t.source?.table === table,
      );
      if (existing) {
        const switched = await switchActiveTab(connectionId, existing.id);
        if (!switched) return;
        const sql = await tableSql(slot.sessionId, schema, table, filter.trim() || null, 0);
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === existing.id
                ? { ...t, sql, filter: filter.trim() || undefined, page: 0 }
                : t,
            ),
          ),
        }));
        await get().runTab(existing.id);
        return;
      }

      const sql = await tableSql(slot.sessionId, schema, table, filter.trim() || null, 0);
      const tab = makeTab({
        kind: "table",
        title: table,
        sql,
        source: { schema, table },
        filter: filter.trim() || undefined,
        page: 0,
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
        return;
      }
      await get().runTab(tab.id);
    },

    async setTableFilter(id, filter) {
      const owner = findTabOwner(get().connections, id);
      if (!owner) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.source) return;
      // Regenerate the table query with the WHERE predicate in the backend.
      // Changing the filter resets to the first page. `runTab` itself guards
      // against discarding unsaved edits.
      const sql = await tableSql(
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        filter.trim() || null,
        0,
      );
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) =>
            t.id === id
              ? { ...t, sql, filter: filter.trim() || undefined, page: 0 }
              : t,
          ),
        ),
      }));
      await get().runTab(id);
    },

    setCellEdit(tabId, rowIndex, colIndex, value) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => {
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
          ),
        };
      });
    },

    discardEdits(tabId) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === tabId
                ? { ...t, pendingEdits: {}, newRows: [], updateError: null }
                : t,
            ),
          ),
        };
      });
    },

    clearUpdateError(tabId) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => (t.id === tabId ? { ...t, updateError: null } : t)),
          ),
        };
      });
    },

    setUpdateError(tabId, error) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => (t.id === tabId ? { ...t, updateError: error } : t)),
          ),
        };
      });
    },

    async commitEdits(tabId) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.result || !tab.source || !tabHasPendingEdits(tab)) return;

      const schemaTable = slot.schema
        .find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table);
      const pkCols = schemaTable?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
      if (pkCols.length === 0) return; // editing is gated on a detected primary key

      const rowIndices = Object.keys(tab.pendingEdits ?? {}).map(Number);

      for (const rowIndex of rowIndices) {
        // Re-read fresh each iteration: prior rows in this loop have already
        // patched `result`/`pendingEdits` in place.
        const current = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
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
          await api.updateRow(slot.sessionId, tab.source.schema, tab.source.table, primaryKey, changes);
          // Apply the change locally so the grid reflects the saved values
          // without a full re-fetch.
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) => {
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
            ),
          }));
        } catch (err) {
          // Stop on the first failure; leave remaining edits pending so
          // nothing already-typed is lost.
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
            ),
          }));
          return;
        }
      }

      // Insert any pending draft rows. Always process the first remaining draft
      // and drop it on success, so a mid-batch failure leaves the offender (and
      // everything after it) still queued for the user to fix.
      let insertedAny = false;
      for (;;) {
        const current = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
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
          await api.insertRow(slot.sessionId, tab.source.schema, tab.source.table, values);
          insertedAny = true;
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) =>
                t.id === tabId
                  ? { ...t, newRows: (t.newRows ?? []).slice(1), updateError: null }
                  : t,
              ),
            ),
          }));
        } catch (err) {
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
            ),
          }));
          return;
        }
      }

      // Re-fetch so inserted rows appear with server-assigned defaults/keys.
      if (insertedAny) await get().runTab(tabId);
    },

    addRow(tabId) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => {
              if (t.id !== tabId || !t.result) return t;
              const blank = Array<string | null>(t.result.columns.length).fill(null);
              return { ...t, newRows: [...(t.newRows ?? []), blank] };
            }),
          ),
        };
      });
    },

    addRows(tabId, rows) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => {
              if (t.id !== tabId || !t.result || rows.length === 0) return t;
              const width = t.result.columns.length;
              const drafts = rows.map((r) => {
                const row = Array<string | null>(width).fill(null);
                for (let ci = 0; ci < width; ci++) row[ci] = r[ci] ?? null;
                return row;
              });
              return { ...t, newRows: [...(t.newRows ?? []), ...drafts] };
            }),
          ),
        };
      });
    },

    setNewCellEdit(tabId, newRowIndex, colIndex, value) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => {
              if (t.id !== tabId || !t.newRows) return t;
              const newRows = t.newRows.map((row, i) => {
                if (i !== newRowIndex) return row;
                const copy = [...row];
                copy[colIndex] = value;
                return copy;
              });
              return { ...t, newRows };
            }),
          ),
        };
      });
    },

    removeNewRow(tabId, newRowIndex) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === tabId && t.newRows
                ? { ...t, newRows: t.newRows.filter((_, i) => i !== newRowIndex) }
                : t,
            ),
          ),
        };
      });
    },

    async deleteExistingRow(tabId, rowIndex) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.result || !tab.source) return;

      const schemaTable = slot.schema
        .find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table);
      const pkCols = schemaTable?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [];
      if (pkCols.length === 0) return; // deletion is gated on a detected primary key

      const ok = await requestConfirm(
        "Delete this row? This permanently removes it from the database.",
        "Delete",
      );
      if (!ok) return;

      // Re-resolve the row after the async confirm (it may have shifted).
      const fresh = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
      const row = fresh?.result?.rows[rowIndex];
      if (!fresh || !fresh.result || !row) return;

      const primaryKey: ColumnValue[] = pkCols.map((pkCol) => {
        const ci = fresh.result!.columns.findIndex((c) => c.name === pkCol);
        return { column: pkCol, value: row[ci] ?? null };
      });

      try {
        await api.deleteRow(slot.sessionId, tab.source.schema, tab.source.table, primaryKey);
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) => {
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
          ),
        }));
      } catch (err) {
        const dbError: DbError = isDbError(err)
          ? err
          : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
          ),
        }));
      }
    },

    async deleteExistingRows(tabId, rowIndices) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner || rowIndices.length === 0) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.result || !tab.source) return;

      const schemaTable = slot.schema
        .find((s) => s.name === tab.source!.schema)
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
        const fresh = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
        const row = fresh?.result?.rows[rowIndex];
        if (!fresh || !fresh.result || !row) continue;

        const primaryKey: ColumnValue[] = pkCols.map((pkCol) => {
          const ci = fresh.result!.columns.findIndex((c) => c.name === pkCol);
          return { column: pkCol, value: row[ci] ?? null };
        });

        try {
          await api.deleteRow(slot.sessionId, tab.source.schema, tab.source.table, primaryKey);
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) => {
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
            ),
          }));
        } catch (err) {
          const dbError: DbError = isDbError(err)
            ? err
            : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
          set((s) => ({
            connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
              tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
            ),
          }));
          return;
        }
      }
    },

    overwriteRow(tabId, rowIndex, values, editableColIndices) {
      set((s) => {
        const owner = findTabOwner(s.connections, tabId);
        if (!owner) return s;
        return {
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) => {
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
          ),
        };
      });
    },

    async setTablePage(tabId, page) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner || owner.tab.running) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.source) return;
      const next = Math.max(0, page);
      if (next === (tab.page ?? 0)) return;
      const sql = await tableSql(
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        tab.filter?.trim() || null,
        next,
      );
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) => (t.id === tabId ? { ...t, sql, page: next } : t)),
        ),
      }));
      await get().runTab(tabId);
    },

    toggleHistory() {
      const next = !get().historyOpen;
      set({ historyOpen: next });
      if (next) void get().refreshHistory();
    },

    toggleCommandPalette() {
      set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen }));
    },

    closeCommandPalette() {
      set({ commandPaletteOpen: false });
    },

    async refreshHistory() {
      try {
        const history = await api.queryHistory(get().historyLimit);
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

    toggleSavedQueries() {
      const next = !get().savedQueriesOpen;
      set({ savedQueriesOpen: next });
      if (next) void get().loadSavedQueries();
    },

    async saveTabAsQuery(tabId, name, mode) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner) return;
      const existingId = mode === "update" ? owner.tab.savedQueryId : undefined;
      const saved = await api.saveQuery({
        id: existingId ?? "",
        name,
        sql: owner.tab.sql,
        createdAt: 0,
      });
      set((s) => {
        const withoutOld = s.savedQueries.filter((q) => q.id !== saved.id);
        return {
          savedQueries: [saved, ...withoutOld],
          connections: mapSlotTabs(s.connections, owner.connectionId, (tabs) =>
            tabs.map((t) =>
              t.id === tabId ? { ...t, savedQueryId: saved.id, title: saved.name } : t,
            ),
          ),
        };
      });
    },

    async openSavedQuery(query) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot) return;

      const existing = slot.tabs.find((t) => t.savedQueryId === query.id);
      if (existing) {
        await switchActiveTab(connectionId, existing.id);
        return;
      }

      const tab = makeTab({
        kind: "query",
        title: query.name,
        sql: query.sql,
        savedQueryId: query.id,
      });
      set((s) => ({ connections: mapSlotTabs(s.connections, connectionId, (tabs) => [...tabs, tab]) }));
      const switched = await switchActiveTab(connectionId, tab.id);
      if (!switched) {
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.filter((t) => t.id !== tab.id),
          ),
        }));
      }
    },

    async renameSavedQuery(id, name) {
      const existing = get().savedQueries.find((q) => q.id === id);
      if (!existing) return;
      const saved = await api.saveQuery({ ...existing, name });
      set((s) => ({
        savedQueries: s.savedQueries.map((q) => (q.id === id ? saved : q)),
        connections: Object.fromEntries(
          Object.entries(s.connections).map(([connectionId, slot]) => [
            connectionId,
            {
              ...slot,
              tabs: slot.tabs.map((t) =>
                t.savedQueryId === id ? { ...t, title: saved.name } : t,
              ),
            },
          ]),
        ),
      }));
    },

    async deleteSavedQueryById(id) {
      await api.deleteSavedQuery(id);
      set((s) => ({
        savedQueries: s.savedQueries.filter((q) => q.id !== id),
        connections: Object.fromEntries(
          Object.entries(s.connections).map(([connectionId, slot]) => [
            connectionId,
            {
              ...slot,
              tabs: slot.tabs.map((t) =>
                t.savedQueryId === id ? { ...t, savedQueryId: undefined } : t,
              ),
            },
          ]),
        ),
      }));
    },

    setTheme(theme) {
      applyTheme(theme);
      applyAccentColor(get().accentColor, theme);
      set({ theme });
    },

    toggleTheme() {
      // With 6 themes across 2 families, "toggle" switches family (to that
      // family's primary theme) rather than cycling through every variant.
      const next: Theme = THEME_MODE[get().theme] === "dark" ? "light" : "dark";
      applyTheme(next);
      applyAccentColor(get().accentColor, next);
      set({ theme: next });
    },

    setAccentColor(color) {
      applyAccentColor(color, get().theme);
      set({ accentColor: color });
    },

    setTableFont(font) {
      applyTableFont(font);
      set({ tableFont: font });
    },

    setTableFontSize(size) {
      applyTableFontSize(size);
      set({ tableFontSize: size });
    },

    setTableRowHeight(height) {
      applyTableRowHeight(height);
      set({ tableRowHeight: height });
    },

    setTableZebra(enabled) {
      applyTableZebra(enabled);
      set({ tableZebra: enabled });
    },

    setTableCellBorders(enabled) {
      applyTableCellBorders(enabled);
      set({ tableCellBorders: enabled });
    },

    setTableHeaderShade(enabled) {
      applyTableHeaderShade(enabled);
      set({ tableHeaderShade: enabled });
    },

    setTableWrapText(enabled) {
      applyTableWrapText(enabled);
      set({ tableWrapText: enabled });
    },

    setNullDisplay(display) {
      saveNullDisplay(display);
      set({ nullDisplay: display });
    },

    setEditorFont(font) {
      applyEditorFont(font);
      set({ editorFont: font });
    },

    setEditorFontSize(size) {
      applyEditorFontSize(size);
      set({ editorFontSize: size });
    },

    setEditorLineWrap(enabled) {
      saveEditorLineWrap(enabled);
      set({ editorLineWrap: enabled });
    },

    setCompactTopBar(enabled) {
      saveCompactTopBar(enabled);
      set({ compactTopBar: enabled });
    },

    setRestoreTabsOnLaunch(enabled) {
      saveRestoreTabsOnLaunch(enabled);
      set({ restoreTabsOnLaunch: enabled });
    },

    setStarterSql(sql) {
      saveStarterSql(sql);
      set({ starterSql: sql });
    },

    setAutoRefreshSchema(enabled) {
      saveAutoRefreshSchema(enabled);
      set({ autoRefreshSchema: enabled });
    },

    setHistoryLimit(limit) {
      saveHistoryLimit(limit);
      set({ historyLimit: limit });
    },

    setCsvDelimiter(delimiter) {
      saveDelimiter(CSV_DELIMITER_KEY, delimiter);
      set({ csvDelimiter: delimiter });
    },

    setRowCopyDelimiter(delimiter) {
      saveDelimiter(ROW_COPY_DELIMITER_KEY, delimiter);
      set({ rowCopyDelimiter: delimiter });
    },

    openSettings() {
      set({ settingsOpen: true });
    },

    closeSettings() {
      set({ settingsOpen: false });
    },
  };
});

// Stable empty fallbacks so selectors below don't create a new array/object
// reference (and trigger a needless re-render) every time there's no active
// connection.
const EMPTY_TABS: QueryTab[] = [];
const EMPTY_SCHEMA: SchemaNode[] = [];

/** The active connection's open tabs. Empty when nothing is connected. */
export function useActiveTabs(): QueryTab[] {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.tabs ?? EMPTY_TABS : EMPTY_TABS,
  );
}

/** The active connection's currently focused tab id. */
export function useActiveTabId(): string | null {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.activeTabId ?? null : null,
  );
}

/** The active connection's schema tree. Empty when nothing is connected. */
export function useActiveSchema(): SchemaNode[] {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.schema ?? EMPTY_SCHEMA : EMPTY_SCHEMA,
  );
}

/** The active connection's schema-fetch loading/error state, for the tree's
 *  own loading/error UI. Two separate hooks (rather than one returning
 *  `{loading, error}`) because a Zustand selector must return a referentially
 *  stable value — a fresh object literal on every call defeats
 *  `useSyncExternalStore`'s snapshot caching and causes an infinite
 *  update-depth loop. */
export function useActiveSchemaLoading(): boolean {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.schemaLoading ?? false : false,
  );
}
export function useActiveSchemaError(): string | null {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.schemaError ?? null : null,
  );
}

// Persist the visible connection's open tabs whenever they (or which
// connection is visible) change, so they can be restored on the next
// launch. Per the scope decision on multi-connection tab persistence (see
// `initialize`), only ever the one connection that gets auto-restored on
// launch actually reads this back — but it's simplest to always keep it in
// sync with whatever's currently visible.
let lastConnections = useStore.getState().connections;
let lastActiveConnectionId = useStore.getState().activeConnectionId;
useStore.subscribe((state) => {
  if (
    state.connections === lastConnections &&
    state.activeConnectionId === lastActiveConnectionId
  ) {
    return;
  }
  lastConnections = state.connections;
  lastActiveConnectionId = state.activeConnectionId;
  const slot = state.activeConnectionId ? state.connections[state.activeConnectionId] : null;
  if (slot) persistTabs(slot.tabs, slot.activeTabId);
});
