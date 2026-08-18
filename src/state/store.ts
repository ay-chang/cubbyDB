/**
 * Central application store (Zustand).
 *
 * Holds connection state, the schema tree, editor tabs, and query history, and
 * orchestrates the backend calls that mutate them. Components read slices of
 * this and dispatch actions; they never call the backend for stateful flows
 * directly (one-shot actions like "test connection" stay local to their form).
 */

import { useMemo } from "react";
import { create } from "zustand";

import * as api from "../api/backend";
import type {
  ActiveConnectionInfo,
  AiChatSummary,
  AiConfigStatus,
  AiMessage,
  AiProvider,
  AiReasoningEffort,
  ColumnValue,
  ConnectionParams,
  Cubby,
  CubbyEntry,
  DbError,
  DeleteImpact,
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
  /**
   * For `table` tabs: the column currently sorted on, if any. Applied as a
   * real `ORDER BY` in the backend (see `tableSql`) rather than sorted
   * client-side, so it covers every row in the table, not just the page
   * that happens to be loaded.
   */
  sortColumn?: string | null;
  sortDesc?: boolean;
}

/** How many rows one page shows, in both the table browser and the SQL
 *  editor's results. Must match `PAGE_SIZE` in `src-tauri/src/db/mod.rs`,
 *  which is what actually bounds the query — the pager's "is there a next
 *  page?" test is `rows === PAGE_SIZE`, so a mismatch would strand the last
 *  page or offer an empty one. */
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
  /** Tab-switch history for Cmd/Ctrl+[ / +] — most-recent last, capped at
   *  `MAX_NAV_HISTORY`. `navBack` holds where we've been; `navForward` holds
   *  what a `navigateBack` just stepped away from, so `navigateForward` can
   *  retrace it. Any *real* tab switch (not itself a history nav) clears
   *  `navForward`, same as a browser losing its forward history once you
   *  navigate somewhere new. */
  navBack: string[];
  navForward: string[];
  /** This connection's own AI chat thread — scoped per connection (like
   *  `tabs`/`schema`) rather than globally, so switching connections shows
   *  that database's own conversation. */
  aiMessages: AiMessage[];
  /** True while an `aiChat` call is in flight for this connection. */
  aiSending: boolean;
  /** A failed turn, shown as a retryable strip under the thread. Deliberately
   *  *not* an assistant message: an error written into `aiMessages` would be
   *  saved to the chat and replayed to the model next turn as something it
   *  supposedly said. Cleared when the turn is retried or a new one starts. */
  aiError: string | null;
  /** Identifies the in-flight turn. Stopping (or starting another) bumps it,
   *  and a reply whose token no longer matches is discarded — see
   *  `stopAiMessage` for why the request itself can't be aborted. */
  aiTurnToken: number;
  /** Which saved chat (see `ai_chats.rs`) the current `aiMessages` is, once
   *  it has one — `null` until the first message of a fresh conversation is
   *  sent, and permanently `null` for ad-hoc connections (no stable id to
   *  save against, so their chats stay in-memory only, same as before this
   *  feature existed). */
  aiChatId: string | null;
  /** This connection's saved-chat list, for the AI panel's History view. */
  aiChats: AiChatSummary[];
  aiChatsLoading: boolean;
  /** Seeded from the matching saved connection's `color` on connect (`null`
   *  for an ad-hoc/never-saved session, or one explicitly left untagged).
   *  Settable live via `setConnectionColor` — persisted back to the saved
   *  record when there is one, kept as session-only state otherwise. */
  color: AccentColor | null;
  /** How `color` renders (results pane border vs. full tint) — a
   *  per-connection choice (set alongside `color` in the connection form),
   *  not a global app setting, since e.g. "prod" might warrant the louder
   *  fill while a merely-tagged staging connection doesn't. */
  colorStyle: ConnectionColorStyle;
}

/** A relation the user opened or returned to during this app session. The
 *  command palette uses this small MRU list for its useful empty state; the
 *  schema remains the source of truth for the relation's current metadata. */
export interface RecentDatabaseObject {
  sessionId: string;
  schema: string;
  table: string;
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

/** The settings modal's top-level tabs — kept here (not in `SettingsDialog`)
 *  since `openSettings` needs to name one as a one-shot "jump to this
 *  section" directive. */
export type SettingsSection = "general" | "appearance" | "aiAssistant" | "shortcuts";

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
  | "purple"
  | "lime"
  | "emerald"
  | "sky"
  | "violet"
  | "fuchsia"
  | "rose"
  | "yellow"
  | "brown"
  | "stone"
  | "zinc";

/** `AccentColor` options in display order. */
export const ACCENT_COLOR_OPTIONS: AccentColor[] = [
  "green",
  "indigo",
  "blue",
  "sky",
  "cyan",
  "teal",
  "emerald",
  "lime",
  "yellow",
  "amber",
  "orange",
  "red",
  "rose",
  "pink",
  "fuchsia",
  "purple",
  "violet",
  "brown",
  "stone",
  "zinc",
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
  lime: "Lime",
  emerald: "Emerald",
  sky: "Sky",
  violet: "Violet",
  fuchsia: "Fuchsia",
  rose: "Rose",
  yellow: "Yellow",
  brown: "Brown",
  stone: "Stone",
  zinc: "Zinc",
};

/** Existing users keep whatever they've already picked (or explicitly left
 *  at the old indigo default) — `loadAccentColor` only falls back to this for
 *  someone with nothing saved yet. */
export const DEFAULT_ACCENT_COLOR: AccentColor = "green";

/** Type guard for a value read back from storage (saved-connection JSON,
 *  localStorage) — the palette can change over time, so a name that isn't
 *  (or is no longer) a real option should fall back to "untagged" rather
 *  than propagate a bogus color through the UI. */
export function isAccentColor(value: string | null | undefined): value is AccentColor {
  return !!value && (ACCENT_COLOR_OPTIONS as string[]).includes(value);
}

export interface AccentPalette {
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
  lime: "#65a30d",
  emerald: "#059669",
  sky: "#0ea5e9",
  violet: "#8b5cf6",
  fuchsia: "#c026d3",
  rose: "#e11d48",
  yellow: "#ca8a04",
  brown: "#8b5a2b",
  stone: "#57534e",
  zinc: "#52525b",
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
  lime: {
    light: {
      accent: "#65a30d",
      accentHover: "#588f0b",
      accentTint: "#eff7e3",
      accentTintText: "#3f6b0a",
      accentGlow: "rgba(101, 163, 13, 0.12)",
      accentGlowSoft: "rgba(101, 163, 13, 0.08)",
    },
    dark: {
      accent: "#a3e635",
      accentHover: "#b3ec55",
      accentTint: "#202b0f",
      accentTintText: "#c8f08a",
      accentGlow: "rgba(163, 230, 53, 0.22)",
      accentGlowSoft: "rgba(163, 230, 53, 0.12)",
    },
  },
  emerald: {
    light: {
      accent: "#059669",
      accentHover: "#047857",
      accentTint: "#e3f8f0",
      accentTintText: "#036e4e",
      accentGlow: "rgba(5, 150, 105, 0.12)",
      accentGlowSoft: "rgba(5, 150, 105, 0.08)",
    },
    dark: {
      accent: "#34d399",
      accentHover: "#57dbac",
      accentTint: "#0f2921",
      accentTintText: "#8bf0c8",
      accentGlow: "rgba(52, 211, 153, 0.22)",
      accentGlowSoft: "rgba(52, 211, 153, 0.12)",
    },
  },
  sky: {
    light: {
      accent: "#0ea5e9",
      accentHover: "#0b8fcc",
      accentTint: "#e5f5fd",
      accentTintText: "#0a6d9c",
      accentGlow: "rgba(14, 165, 233, 0.12)",
      accentGlowSoft: "rgba(14, 165, 233, 0.08)",
    },
    dark: {
      accent: "#38bdf8",
      accentHover: "#61cbfa",
      accentTint: "#102633",
      accentTintText: "#92dbfb",
      accentGlow: "rgba(56, 189, 248, 0.22)",
      accentGlowSoft: "rgba(56, 189, 248, 0.12)",
    },
  },
  violet: {
    light: {
      accent: "#8b5cf6",
      accentHover: "#7a48ef",
      accentTint: "#f1edfe",
      accentTintText: "#5d34c9",
      accentGlow: "rgba(139, 92, 246, 0.12)",
      accentGlowSoft: "rgba(139, 92, 246, 0.08)",
    },
    dark: {
      accent: "#a78bfa",
      accentHover: "#bba4fb",
      accentTint: "#211c37",
      accentTintText: "#d3c3fc",
      accentGlow: "rgba(167, 139, 250, 0.22)",
      accentGlowSoft: "rgba(167, 139, 250, 0.12)",
    },
  },
  fuchsia: {
    light: {
      accent: "#c026d3",
      accentHover: "#a81fb8",
      accentTint: "#fbe9fc",
      accentTintText: "#8f1a9c",
      accentGlow: "rgba(192, 38, 211, 0.12)",
      accentGlowSoft: "rgba(192, 38, 211, 0.08)",
    },
    dark: {
      accent: "#e879f9",
      accentHover: "#ee97fa",
      accentTint: "#2f1730",
      accentTintText: "#f4b8fb",
      accentGlow: "rgba(232, 121, 249, 0.22)",
      accentGlowSoft: "rgba(232, 121, 249, 0.12)",
    },
  },
  rose: {
    light: {
      accent: "#e11d48",
      accentHover: "#c11740",
      accentTint: "#fde9ee",
      accentTintText: "#9f1239",
      accentGlow: "rgba(225, 29, 72, 0.12)",
      accentGlowSoft: "rgba(225, 29, 72, 0.08)",
    },
    dark: {
      accent: "#fb7185",
      accentHover: "#fc93a3",
      accentTint: "#2d151a",
      accentTintText: "#fbb8c4",
      accentGlow: "rgba(251, 113, 133, 0.22)",
      accentGlowSoft: "rgba(251, 113, 133, 0.12)",
    },
  },
  yellow: {
    light: {
      accent: "#ca8a04",
      accentHover: "#a97103",
      accentTint: "#fdf6e0",
      accentTintText: "#855c02",
      accentGlow: "rgba(202, 138, 4, 0.12)",
      accentGlowSoft: "rgba(202, 138, 4, 0.08)",
    },
    dark: {
      accent: "#facc15",
      accentHover: "#fbdb4d",
      accentTint: "#2b2408",
      accentTintText: "#fbe28a",
      accentGlow: "rgba(250, 204, 21, 0.22)",
      accentGlowSoft: "rgba(250, 204, 21, 0.12)",
    },
  },
  stone: {
    light: {
      accent: "#57534e",
      accentHover: "#44403c",
      accentTint: "#f0eeec",
      accentTintText: "#44403c",
      accentGlow: "rgba(87, 83, 78, 0.12)",
      accentGlowSoft: "rgba(87, 83, 78, 0.08)",
    },
    dark: {
      accent: "#a8a29e",
      accentHover: "#d6d3d1",
      accentTint: "#211f1d",
      accentTintText: "#d6d3d1",
      accentGlow: "rgba(168, 162, 158, 0.22)",
      accentGlowSoft: "rgba(168, 162, 158, 0.12)",
    },
  },
  // The one warm mid-tone the wheel above never covers — and, as a connection
  // tag, readably distinct from amber and orange.
  brown: {
    light: {
      accent: "#8b5a2b",
      accentHover: "#74491f",
      accentTint: "#f5eee6",
      accentTintText: "#74491f",
      accentGlow: "rgba(139, 90, 43, 0.12)",
      accentGlowSoft: "rgba(139, 90, 43, 0.08)",
    },
    dark: {
      accent: "#c69963",
      accentHover: "#d8b183",
      accentTint: "#2a1f14",
      accentTintText: "#e0c39a",
      accentGlow: "rgba(198, 153, 99, 0.22)",
      accentGlowSoft: "rgba(198, 153, 99, 0.12)",
    },
  },
  // Cool-gray counterpart to stone's warm gray.
  zinc: {
    light: {
      accent: "#52525b",
      accentHover: "#3f3f46",
      accentTint: "#eeeef0",
      accentTintText: "#3f3f46",
      accentGlow: "rgba(82, 82, 91, 0.12)",
      accentGlowSoft: "rgba(82, 82, 91, 0.08)",
    },
    dark: {
      accent: "#a1a1aa",
      accentHover: "#d4d4d8",
      accentTint: "#1e1e21",
      accentTintText: "#d4d4d8",
      accentGlow: "rgba(161, 161, 170, 0.22)",
      accentGlowSoft: "rgba(161, 161, 170, 0.12)",
    },
  },
};

/** Looks up one accent color's theme-appropriate values — used for the
 *  connection-color feature (results-pane border/fill), which renders an
 *  arbitrary named color correctly against whichever theme is active, unlike
 *  `ACCENT_COLOR_SWATCH` (deliberately fixed to the light-mode value so
 *  Settings' picker swatches stay consistent regardless of theme). */
export function accentPaletteFor(color: AccentColor, mode: ThemeMode): AccentPalette {
  return ACCENT_PALETTES[color][mode];
}

/** How a tagged connection's color renders in the results pane — set
 *  per-connection (see `ConnectionSlot.colorStyle`/the connection form),
 *  not a global app setting. */
export type ConnectionColorStyle = "border" | "fill";

export const DEFAULT_CONNECTION_COLOR_STYLE: ConnectionColorStyle = "border";

/** Type guard for a value read back from a saved connection's `colorStyle`
 *  — same reasoning as `isAccentColor`: a stored value could be stale or
 *  absent, so fall back to the default rather than propagate garbage. */
export function isConnectionColorStyle(
  value: string | null | undefined,
): value is ConnectionColorStyle {
  return value === "border" || value === "fill";
}

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

/** The sidebar (schema tree) row height, in px. Persisted across launches. */
export type SidebarRowHeight = number;

/** Selectable row heights (px) offered in the Settings dropdown, with a
 *  density label for each — a tighter range than the results grid's, since a
 *  tree row only ever holds an icon and one line of text. */
export const SIDEBAR_ROW_HEIGHT_OPTIONS: { px: number; label: string }[] = [
  { px: 22, label: "Compact" },
  { px: 24, label: "Cozy" },
  { px: 27, label: "Comfortable" },
  { px: 30, label: "Relaxed" },
  { px: 34, label: "Spacious" },
];

export const DEFAULT_SIDEBAR_ROW_HEIGHT: SidebarRowHeight = 24;

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

/** Shown instead of the plain `ConfirmDialogState` when a delete would
 *  cascade into other tables — same "decision, not an error, worth
 *  blocking on" precedent, just with a structured impact to render rather
 *  than a single message string. */
interface DeleteImpactDialogState {
  impact: DeleteImpact;
  /** How many rows were directly requested to be deleted (before cascading) —
   *  carried alongside `impact` so the dialog can say "deleting N rows will
   *  also delete M related rows" instead of just the dependent count. */
  rootCount: number;
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

  /** Every cubby (all connections' — the panel filters to the active one).
   *  Small, reference-only records, so unlike AI chats there's no
   *  list/full-record split. */
  cubbies: Cubby[];
  cubbiesOpen: boolean;
  /** The cubby currently "open" — pins its tables in the schema tree and
   *  feeds them to the AI as extra context. `null` means no cubby is
   *  active, identical to today's behavior. Cleared automatically on
   *  switching to a connection the cubby doesn't belong to. */
  activeCubbyId: string | null;

  /** Every live connection's workspace, keyed by session id. */
  connections: Record<string, ConnectionSlot>;
  /** Which connection's workspace is currently visible. */
  activeConnectionId: string | null;

  history: HistoryEntry[];
  historyOpen: boolean;

  /** Most-recently-used relations across all currently open connections. */
  recentDatabaseObjects: RecentDatabaseObject[];

  /** Right-drawer AI chat panel, toggled the same way as History/Saved
   *  Queries. Messages live per-connection (see `ConnectionSlot.aiMessages`);
   *  this only tracks whether the panel itself is visible. */
  aiPanelOpen: boolean;
  /** Which provider is active and whether each has a key saved — never the
   *  real keys. `null` until `loadAiConfig` has fetched it at least once. */
  aiConfig: AiConfigStatus | null;
  /** Whether the AI panel is showing the saved-chats list instead of the
   *  active conversation — a UI mode, not per-connection data, so it lives
   *  here rather than on `ConnectionSlot`. */
  aiHistoryView: boolean;

  /** Cmd/Ctrl+K workspace switcher and cross-connection search. */
  commandPaletteOpen: boolean;
  /** A one-shot request for `TableStructurePane` to scroll to and flash a
   *  specific column, set by jumping to it from the command palette. Keyed
   *  by a `nonce` so re-jumping to the same column still re-triggers the
   *  effect; cleared once consumed. */
  pendingColumnHighlight: { schema: string; table: string; column: string; nonce: number } | null;

  /** A transient success/failure notice, shown bottom-right and dismissed on
   *  a timer. For actions whose result is otherwise invisible — an export
   *  that wrote a file somewhere the user can't see from here. */
  toast: { message: string; kind: "success" | "error" } | null;
  showToast: (message: string, kind?: "success" | "error") => void;

  /** When set, a "leave without saving?" confirmation is shown. */
  confirmDialog: ConfirmDialogState | null;
  /** When set, the delete-impact dialog is shown instead of the plain
   *  `confirmDialog` — a delete that would cascade into other tables. */
  deleteImpactDialog: DeleteImpactDialogState | null;

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
  /** Sidebar (schema tree) row height, applied to the document root. */
  sidebarRowHeight: SidebarRowHeight;
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
  /** Whether opening a cubby first closes the connection's other tabs, so it
   *  opens onto a clean slate instead of adding to whatever was already
   *  there. Off by default — additive is the less destructive default. */
  closeTabsOnCubbyOpen: boolean;
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
  /** A one-shot directive for which settings section to jump to next time the
   *  dialog opens (e.g. the AI panel's "Open Settings" link landing on AI
   *  Assistant instead of whatever tab was last open) — `null` means "leave
   *  it wherever the user last had it." Consumed by `SettingsDialog` itself. */
  settingsSection: SettingsSection | null;
  /** Tab id currently doing a "silent" refresh (see `runTab`'s `silent`
   *  option) — the one thing this drives is `ResultsHeader` keeping its
   *  existing stats on screen instead of swapping to the "Running…/Cancel"
   *  takeover, since a background refresh of already-loaded data shouldn't
   *  read as a brand new, cancelable query. */
  silentRefreshTabId: string | null;
  /** Session id the "edit connection" overlay is open for, if any — lifted
   *  out of `TopBar` (which still renders the overlay) so other UI, like the
   *  AI panel's "this connection isn't saved" nudge, can open it too. */
  editConnectionSessionId: string | null;
  openEditConnection: (sessionId: string) => void;
  closeEditConnection: () => void;

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

  // --- cubbies ---
  loadCubbies: () => Promise<void>;
  toggleCubbies: () => void;
  createCubby: (name: string) => Promise<void>;
  renameCubby: (id: string, name: string) => Promise<void>;
  deleteCubbyById: (id: string) => Promise<void>;
  /** Restores every entry in a cubby — switching to its connection (if
   *  already open elsewhere) and opening/focusing a tab for each saved
   *  query, table, chat, and structure/function/sequence view it holds.
   *  Sets it as the active cubby (pins its tables in the schema tree, and
   *  feeds them to the AI as extra context). Connects to the cubby's
   *  database first if it isn't already open. */
  openCubby: (id: string) => Promise<void>;
  /** Clears the active cubby without touching any open tabs or deleting it —
   *  "I'm done working in this context for now." */
  closeCubby: () => void;
  addEntryToCubby: (cubbyId: string, entry: CubbyEntry) => Promise<void>;
  removeEntryFromCubby: (cubbyId: string, entry: CubbyEntry) => Promise<void>;
  /** Removes every entry (both `table` and `structure` kinds) pointing at one
   *  relation, in a single update — what the schema tree's pinned section
   *  uses, since a pinned row represents the relation, not one specific
   *  entry kind, and firing `removeEntryFromCubby` twice back-to-back would
   *  race against its own read-modify-write. */
  removeTableFromCubby: (cubbyId: string, schema: string, table: string) => Promise<void>;
  /** Open a new connection and add it as a slot — never replaces an
   *  existing one, so connecting to a second database leaves the first
   *  live. Becomes the active (visible) slot. */
  connectTo: (
    connection: Pick<SavedConnection, "params" | "name"> & { id?: string },
    /** Pass `false` when re-establishing the connection that was *just read*
     *  from the last-connection store (launch's own auto-reconnect) — no
     *  need to write the identical record straight back to disk. Defaults to
     *  `true` for every other caller (a real, possibly new, user-initiated
     *  connect). */
    options?: { rememberAsLast?: boolean },
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
  /** Tags a live session with a color and how it renders (border/fill),
   *  updating it immediately. If the session is backed by a saved
   *  connection, both are also persisted there (so they survive
   *  reconnects/restarts); an ad-hoc session just keeps them in memory for
   *  the life of this session. */
  setConnectionColor: (
    sessionId: string,
    color: AccentColor | null,
    colorStyle: ConnectionColorStyle,
  ) => Promise<void>;
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
  /** Cmd/Ctrl+[ — re-activate whichever tab was active just before the
   *  current one, like a browser's back button. No-ops at the start of
   *  history. */
  navigateBack: () => void;
  /** Cmd/Ctrl+] — the reverse of `navigateBack`. No-ops unless `navigateBack`
   *  (or another `navigateForward`) has run since the last real tab switch. */
  navigateForward: () => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  setTabSql: (id: string, sql: string) => void;
  /** Run a tab's query. `sqlOverride`, if given, is sent to the backend
   *  instead of the tab's own `sql` (e.g. just the statement under the
   *  cursor, or a selection) — the tab's editor buffer is never changed by
   *  this, only what gets executed and logged to history. Pass
   *  `opts.silent` for a background refresh of already-loaded data (see
   *  `silentRefreshTabId`) rather than a user-initiated run — it skips the
   *  "Running…/Cancel" takeover in the results header. */
  runTab: (
    id: string,
    sqlOverride?: string,
    opts?: { silent?: boolean; page?: number },
  ) => Promise<void>;
  /** Re-runs a query tab's SQL at another page of its result. */
  setQueryPage: (tabId: string, page: number) => Promise<void>;
  /** Refreshes the schema tree and, if the active tab has already run once,
   *  silently re-runs it too — the combined action behind the top bar's
   *  Refresh button and the Cmd/Ctrl+R shortcut, so both pick up e.g. a row
   *  inserted via the API without a disruptive loading takeover. */
  refreshActive: () => Promise<void>;
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
  /** Sort a `table` tab by a column, applied as a real `ORDER BY` in the
   *  backend (covers the whole table, not just the loaded page) — resets
   *  back to the first page since the row ordering has changed. `column:
   *  null` clears the sort back to the table's natural order. */
  setTableSort: (tabId: string, column: string | null, desc: boolean) => Promise<void>;

  // --- history ---
  toggleHistory: () => void;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  rerunFromHistory: (sql: string) => void;

  // --- command palette ---
  toggleCommandPalette: () => void;
  closeCommandPalette: () => void;

  // --- ai assistant ---
  toggleAiPanel: () => void;
  /** Sends `text` as a user message in the *active* connection's thread,
   *  waits for the reply, and appends both. */
  sendAiMessage: (text: string) => Promise<void>;
  /** Runs a turn against whatever is already in the thread. Shared by
   *  `sendAiMessage` and `retryAiMessage`; not called directly from the UI. */
  runAiTurn: (connectionId: string) => Promise<void>;
  /** Re-runs the last turn after a failure. */
  retryAiMessage: () => Promise<void>;
  /** Drops the last reply and asks the same question again. */
  regenerateAiMessage: () => Promise<void>;
  /** Abandons the in-flight turn and re-enables the input. */
  stopAiMessage: () => void;
  loadAiConfig: () => Promise<void>;
  saveAiProvider: (provider: AiProvider) => Promise<void>;
  saveAiConfig: (provider: AiProvider, apiKey: string) => Promise<void>;
  clearAiConfig: (provider: AiProvider) => Promise<void>;
  startCodexLogin: () => Promise<void>;
  startClaudeCodeLogin: () => Promise<void>;
  logoutCodex: () => Promise<void>;
  logoutClaudeCode: () => Promise<void>;
  saveAiModel: (
    provider: AiProvider,
    model: string,
    supportsEffort: boolean,
  ) => Promise<void>;
  saveAiReasoningEffort: (
    provider: AiProvider,
    effort: AiReasoningEffort,
  ) => Promise<void>;
  /** Flips between the conversation and the saved-chats list; loads the list
   *  on open, same "toggle then refetch" idiom as `toggleSavedQueries`. */
  toggleAiHistoryView: () => void;
  /** Loads the active connection's saved-chat list (a no-op, clearing the
   *  list, if it has no stable connection id to save chats against). */
  loadAiChats: () => Promise<void>;
  /** Clears the active connection's current thread to start fresh — nothing
   *  is persisted until the first message of the new conversation is sent. */
  newAiChat: () => void;
  /** Opens a saved chat as the active connection's current thread. */
  openAiChat: (id: string) => Promise<void>;
  renameAiChat: (id: string, title: string) => Promise<void>;
  deleteAiChat: (id: string) => Promise<void>;

  // --- appearance / settings ---
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccentColor: (color: AccentColor) => void;
  setTableFont: (font: TableFont) => void;
  setTableFontSize: (size: TableFontSize) => void;
  setTableRowHeight: (height: TableRowHeight) => void;
  setSidebarRowHeight: (height: SidebarRowHeight) => void;
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
  setCloseTabsOnCubbyOpen: (enabled: boolean) => void;
  setStarterSql: (sql: string) => void;
  setAutoRefreshSchema: (enabled: boolean) => void;
  setHistoryLimit: (limit: number) => void;
  setCsvDelimiter: (delimiter: Delimiter) => void;
  setRowCopyDelimiter: (delimiter: Delimiter) => void;
  /** Opens the settings modal. Pass `section` to jump straight to a
   *  particular tab (e.g. the AI panel's "Open Settings" link landing on AI
   *  Assistant); omit it to leave the dialog on whatever section the user
   *  had open last. */
  openSettings: (section?: SettingsSection) => void;
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
const SIDEBAR_ROW_HEIGHT_KEY = "cubbydb:sidebarRowHeight";
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
const CLOSE_TABS_ON_CUBBY_OPEN_KEY = "cubbydb:closeTabsOnCubbyOpen";
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

/** Read the saved sidebar row height (px), defaulting to the standard height. */
function loadSidebarRowHeight(): SidebarRowHeight {
  try {
    const saved = parseFloat(localStorage.getItem(SIDEBAR_ROW_HEIGHT_KEY) ?? "");
    return Number.isFinite(saved) ? saved : DEFAULT_SIDEBAR_ROW_HEIGHT;
  } catch {
    return DEFAULT_SIDEBAR_ROW_HEIGHT;
  }
}

/** Reflect the row height onto the `--h-tree-row` CSS variable and persist it. */
function applySidebarRowHeight(height: SidebarRowHeight) {
  try {
    document.documentElement.style.setProperty("--h-tree-row", `${height}px`);
  } catch {
    // No document (e.g. non-DOM context) — non-fatal.
  }
  try {
    localStorage.setItem(SIDEBAR_ROW_HEIGHT_KEY, String(height));
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

/** Read the saved close-tabs-on-cubby-open preference. Defaults to *off*,
 *  unlike most toggles here: it discards open tabs, so the additive
 *  behavior is the safe default and clearing is opt-in. */
function loadCloseTabsOnCubbyOpen(): boolean {
  try {
    return localStorage.getItem(CLOSE_TABS_ON_CUBBY_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function saveCloseTabsOnCubbyOpen(enabled: boolean) {
  try {
    localStorage.setItem(CLOSE_TABS_ON_CUBBY_OPEN_KEY, String(enabled));
  } catch {
    // Storage unavailable — non-fatal.
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
applySidebarRowHeight(loadSidebarRowHeight());
applyTableZebra(loadTableZebra());
applyTableCellBorders(loadTableCellBorders());
applyTableHeaderShade(loadTableHeaderShade());
applyTableWrapText(loadTableWrapText());
applyEditorFont(loadEditorFont());
applyEditorFontSize(loadEditorFontSize());

// Guards against React StrictMode invoking initialize() twice on mount, which
// would open two connections and leave one orphaned.
let didInitialize = false;

/** Timer for the current toast, so a second one replaces the first rather
 *  than being cut short by the earlier timeout. */
let toastTimer: number | null = null;

/** Build a table-browser query for a given page (backend owns the SQL). */
function tableSql(
  sessionId: string,
  schema: string,
  table: string,
  filter: string | null,
  page: number,
  sort?: { column: string; desc: boolean } | null,
): Promise<string> {
  return api.selectTopSql(
    sessionId,
    schema,
    table,
    filter,
    PAGE_SIZE,
    page * PAGE_SIZE,
    sort?.column ?? null,
    sort?.desc ?? false,
  );
}

/** Locate which connection owns a given tab id (tabs are only ever looked up
 *  by id from components, never by connection, so most tab actions address
 *  their target this way rather than assuming "the active connection" —
 *  correct even if the user switches connections while e.g. a query is
 *  still running in a background one). */
/** Structural equality for two cubby entries — used to dedupe "add to cubby"
 *  (adding the same table twice is a no-op, not a duplicate row) and to
 *  find-and-remove one entry from the list. Plain field comparison rather
 *  than JSON.stringify: key order in an object literal is stable per call
 *  site in practice, but this doesn't depend on that. */
export function cubbyEntryEquals(a: CubbyEntry, b: CubbyEntry): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "savedQuery":
      return b.kind === "savedQuery" && a.savedQueryId === b.savedQueryId;
    case "chat":
      return b.kind === "chat" && a.chatId === b.chatId;
    case "table":
    case "structure":
      return b.kind === a.kind && a.schema === b.schema && a.table === b.table;
    case "function":
      return b.kind === "function" && a.schema === b.schema && a.name === b.name;
    case "sequence":
      return b.kind === "sequence" && a.schema === b.schema && a.name === b.name;
  }
}

/** The distinct (schema, table) pairs a cubby names — from its `table` and
 *  `structure` entries (both point at a real relation; `structure` is just a
 *  different view of the same table). Used to pin the schema tree section and
 *  to tell the AI which tables in a large schema deserve full detail. */
export function cubbyTableRefs(cubby: Cubby): { schema: string; table: string }[] {
  const seen = new Set<string>();
  const out: { schema: string; table: string }[] = [];
  for (const entry of cubby.entries) {
    if (entry.kind !== "table" && entry.kind !== "structure") continue;
    const key = `${entry.schema}.${entry.table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ schema: entry.schema, table: entry.table });
  }
  return out;
}

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

/** Pops entries off a nav-history stack (most-recent last) until it finds one
 *  that's still a real, non-active tab — an id left over from a since-closed
 *  tab is discarded along the way rather than returned. Returns the
 *  remaining stack either way, so a caller that comes up empty can still
 *  persist the pruning instead of re-scanning the same dead entries next
 *  time. */
function popValidTabId(
  stack: string[],
  slot: ConnectionSlot,
): { id: string | null; stack: string[] } {
  const remaining = [...stack];
  while (remaining.length > 0) {
    const candidate = remaining.pop()!;
    if (candidate !== slot.activeTabId && slot.tabs.some((t) => t.id === candidate)) {
      return { id: candidate, stack: remaining };
    }
  }
  return { id: null, stack: remaining };
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

/** Removes `rowIndices` from a table tab's result set, re-indexing any
 *  pending edits around the gaps they leave — shared by the plain
 *  one-row-at-a-time delete path and the atomic cascade-delete path. */
function removeRowsFromTab(t: QueryTab, rowIndices: number[]): QueryTab {
  if (!t.result || rowIndices.length === 0) return t;
  const removed = new Set(rowIndices);
  const rows = t.result.rows.filter((_, i) => !removed.has(i));
  const pendingEdits: Record<number, Record<number, string | null>> = {};
  for (const [k, v] of Object.entries(t.pendingEdits ?? {})) {
    const ri = Number(k);
    if (removed.has(ri)) continue;
    const shift = rowIndices.filter((r) => r < ri).length;
    pendingEdits[ri - shift] = v;
  }
  return {
    ...t,
    result: { ...t.result, rows, rowCount: Math.max(0, t.result.rowCount - rowIndices.length) },
    pendingEdits,
    updateError: null,
  };
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
  const rememberDatabaseObject = (
    sessionId: string,
    schema: string,
    table: string,
  ) => {
    set((s) => ({
      recentDatabaseObjects: [
        { sessionId, schema, table },
        ...s.recentDatabaseObjects.filter(
          (item) =>
            item.sessionId !== sessionId ||
            item.schema !== schema ||
            item.table !== table,
        ),
      ].slice(0, 12),
    }));
  };

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

  /** Gates `startCodexLogin`/`startClaudeCodeLogin`: connecting a
   *  subscription-based AI provider routes requests through the user's own
   *  Anthropic/OpenAI account, which is subject to that provider's own terms
   *  (see cubbydb.com/terms) rather than anything CubbyDB controls. Resolves
   *  `true` once accepted — either already, or via this turn's confirmation
   *  — and `false` if the user backs out, in which case the caller should
   *  not start the CLI login. Acceptance is persisted (`acceptAiTerms`), so
   *  this only prompts once per terms version, not on every sign-in. */
  async function ensureAiTermsAccepted(): Promise<boolean> {
    if (get().aiConfig?.termsAccepted) return true;
    const ok = await requestConfirm(
      "Signing in connects your own Claude or ChatGPT subscription account through its official " +
        "CLI. CubbyDB never sees your login credentials, but using a subscription this way is " +
        "subject to that provider's own terms of service, which may restrict third-party use " +
        "and could result in the provider limiting your account. See cubbydb.com/terms for " +
        "details. Continue at your own risk?",
      "I understand, continue",
    );
    if (!ok) return false;
    const aiConfig = await api.acceptAiTerms();
    set({ aiConfig });
    return true;
  }

  /** Same shape as `requestConfirm`, but for a delete that would cascade
   *  into other tables — shows the structured `DeleteImpactDialog` instead
   *  of a plain message. */
  function requestDeleteImpactConfirm(impact: DeleteImpact, rootCount: number): Promise<boolean> {
    return new Promise((resolve) => {
      set({
        deleteImpactDialog: {
          impact,
          rootCount,
          onConfirm: () => {
            set({ deleteImpactDialog: null });
            resolve(true);
          },
          onCancel: () => {
            set({ deleteImpactDialog: null });
            resolve(false);
          },
        },
      });
    });
  }

  /**
   * Shared by `deleteExistingRow`/`deleteExistingRows`: resolves each row's
   * primary key, previews the delete's impact, confirms (plain or
   * impact-aware, depending on what the preview found), then actually
   * deletes.
   *
   * The two resulting paths differ deliberately: a plain delete (no known
   * dependents) still goes one row at a time, reflecting each success in
   * the grid immediately — so a mid-loop failure leaves whatever was
   * already deleted removed from view too, matching the database. A
   * cascade delete is one backend transaction (all-or-nothing), so local
   * state only needs updating once, on success.
   */
  async function performRowDeletion(
    connectionId: string,
    tabId: string,
    sessionId: string,
    schema: string,
    table: string,
    pkCols: string[],
    rowIndices: number[],
  ): Promise<void> {
    const fresh = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
    if (!fresh?.result) return;

    const resolvedIndices: number[] = [];
    const primaryKeys: ColumnValue[][] = [];
    for (const rowIndex of rowIndices) {
      const row = fresh.result.rows[rowIndex];
      if (!row) continue;
      resolvedIndices.push(rowIndex);
      primaryKeys.push(
        pkCols.map((pkCol) => {
          const ci = fresh.result!.columns.findIndex((c) => c.name === pkCol);
          return { column: pkCol, value: row[ci] ?? null };
        }),
      );
    }
    if (primaryKeys.length === 0) return;

    let impact: DeleteImpact;
    try {
      impact = await api.getDeleteImpact(sessionId, schema, table, primaryKeys);
    } catch {
      // Preview failed (e.g. a transient hiccup) — fall back to the plain
      // confirm rather than blocking the delete outright; a real FK
      // violation still surfaces normally from the delete itself if there
      // turns out to be one.
      impact = { dependents: [], incomplete: false };
    }

    const n = resolvedIndices.length;
    const hasImpact = impact.dependents.length > 0;
    const ok = hasImpact
      ? await requestDeleteImpactConfirm(impact, n)
      : await requestConfirm(
          n === 1
            ? "Delete this row? This permanently removes it from the database."
            : `Delete ${n} rows? This permanently removes them from the database.`,
          "Delete",
        );
    if (!ok) return;

    const toDbError = (err: unknown): DbError =>
      isDbError(err)
        ? err
        : { message: errorMessage(err), code: null, hint: null, position: null, kind: "internal" };
    const setError = (dbError: DbError) => {
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) => (t.id === tabId ? { ...t, updateError: dbError } : t)),
        ),
      }));
    };

    if (hasImpact) {
      try {
        await api.deleteRowsCascade(sessionId, schema, table, primaryKeys);
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) => (t.id === tabId ? removeRowsFromTab(t, resolvedIndices) : t)),
          ),
        }));
      } catch (err) {
        setError(toDbError(err));
      }
      return;
    }

    // Highest index first, so removing one doesn't shift the indices of
    // rows not yet handled; re-resolve each row fresh right before
    // deleting it, since an earlier iteration may have changed the tab.
    const sorted = [...resolvedIndices].sort((a, b) => b - a);
    for (const rowIndex of sorted) {
      const current = get().connections[connectionId]?.tabs.find((t) => t.id === tabId);
      const row = current?.result?.rows[rowIndex];
      if (!current?.result || !row) continue;
      const primaryKey = pkCols.map((pkCol) => {
        const ci = current.result!.columns.findIndex((c) => c.name === pkCol);
        return { column: pkCol, value: row[ci] ?? null };
      });
      try {
        await api.deleteRow(sessionId, schema, table, primaryKey);
        set((s) => ({
          connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
            tabs.map((t) => (t.id === tabId ? removeRowsFromTab(t, [rowIndex]) : t)),
          ),
        }));
      } catch (err) {
        setError(toDbError(err));
        return;
      }
    }
  }

  /** Cap on `navBack`/`navForward` — enough to retrace a real drill-down
   *  session (FK jump after FK jump) without the stacks growing unbounded
   *  over a long-lived connection. */
  const MAX_NAV_HISTORY = 10;

  /**
   * Change a connection's active tab, first confirming if its current tab
   * has unsaved cell edits. Returns whether the switch actually happened.
   * Takes an explicit `connectionId` (rather than assuming "the active
   * connection") so callers that already resolved a specific slot — e.g. via
   * `findTabOwner` — stay correct even if the visible connection changes
   * mid-await.
   *
   * Every real switch (not `opts.isHistoryNav`) is recorded onto the slot's
   * `navBack` stack for Cmd/Ctrl+[ / +], same as a browser's history —
   * `navigateBack`/`navigateForward` themselves call back in here with
   * `isHistoryNav: true` so retracing steps doesn't also record new ones.
   */
  async function switchActiveTab(
    connectionId: string,
    newId: string,
    opts?: { isHistoryNav?: boolean },
  ): Promise<boolean> {
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
    set((s) => {
      const prev = s.connections[connectionId];
      if (!prev) return {};
      const prevActiveId = prev.activeTabId;
      const history =
        !opts?.isHistoryNav && prevActiveId && prevActiveId !== newId
          ? {
              navBack: [...prev.navBack, prevActiveId].slice(-MAX_NAV_HISTORY),
              navForward: [],
            }
          : {};
      return {
        connections: patchSlot(s.connections, connectionId, {
          activeTabId: newId,
          ...history,
        }),
      };
    });
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
    cubbies: [],
    cubbiesOpen: false,
    activeCubbyId: null,
    connections: {},
    activeConnectionId: null,
    history: [],
    historyOpen: false,
    recentDatabaseObjects: [],
    aiPanelOpen: false,
    aiConfig: null,
    aiHistoryView: false,
    commandPaletteOpen: false,
    pendingColumnHighlight: null,
    toast: null,
    confirmDialog: null,
    deleteImpactDialog: null,
    theme: loadTheme(),
    accentColor: loadAccentColor(),
    tableFont: loadTableFont(),
    tableFontSize: loadTableFontSize(),
    tableRowHeight: loadTableRowHeight(),
    sidebarRowHeight: loadSidebarRowHeight(),
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
    closeTabsOnCubbyOpen: loadCloseTabsOnCubbyOpen(),
    starterSql: loadStarterSql(),
    autoRefreshSchema: loadAutoRefreshSchema(),
    historyLimit: loadHistoryLimit(),
    csvDelimiter: loadDelimiter(CSV_DELIMITER_KEY, ","),
    rowCopyDelimiter: loadDelimiter(ROW_COPY_DELIMITER_KEY, "\t"),
    settingsOpen: false,
    settingsSection: null,
    silentRefreshTabId: null,
    editConnectionSessionId: null,

    async initialize() {
      if (didInitialize) return;
      didInitialize = true;

      await get().loadSavedConnections();
      await get().loadSavedQueries();
      await get().loadCubbies();

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
        // Read the persisted tabs *before* connecting: `connectTo` below
        // seeds the new slot with a single blank tab and, via the
        // `connections`-change subscriber further down this file, that
        // immediately overwrites `TABS_KEY` in storage — clobbering the very
        // tabs (including table tabs) this is about to restore if read any
        // later than this.
        const pendingRestore =
          get().restoreTabsOnLaunch ? loadPersistedTabs() : null;

        await get().connectTo(
          { params: last.params, name: last.name, id: last.id ?? undefined },
          { rememberAsLast: false },
        );

        // Restore the tabs that were open last time (without their stale
        // results), unless the user has opted out. Only this one
        // auto-restored connection gets its tabs restored — connections
        // added manually during a session always start with one blank tab
        // and don't persist across a restart.
        const connectionId = get().activeConnectionId;
        if (connectionId && pendingRestore) {
          set((s) => ({
            connections: patchSlot(s.connections, connectionId, {
              tabs: pendingRestore.tabs,
              activeTabId: pendingRestore.activeTabId,
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

    async connectTo(connection, options) {
      const info = await api.connect(
        connection.params,
        connection.name,
        connection.id ?? null,
        options?.rememberAsLast ?? true,
      );
      const tab = makeTab({ sql: get().starterSql });
      const savedRecord = connection.id
        ? get().savedConnections.find((c) => c.id === connection.id)
        : undefined;
      const slot: ConnectionSlot = {
        sessionId: info.sessionId,
        current: info,
        params: connection.params,
        schema: [],
        schemaLoading: false,
        schemaError: null,
        tabs: [tab],
        activeTabId: tab.id,
        navBack: [],
        navForward: [],
        aiMessages: [],
        aiSending: false,
        aiError: null,
        aiTurnToken: 0,
        aiChatId: null,
        aiChats: [],
        aiChatsLoading: false,
        color: isAccentColor(savedRecord?.color) ? savedRecord.color : null,
        colorStyle: isConnectionColorStyle(savedRecord?.colorStyle)
          ? savedRecord.colorStyle
          : DEFAULT_CONNECTION_COLOR_STYLE,
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
      const slot = get().connections[sessionId];
      if (!slot) return;
      // A cubby belongs to one connection — switching to a different one
      // (or an ad-hoc slot with no saved identity) un-pins it rather than
      // showing another database's tables as if they were this one's.
      const activeCubbyId = get().activeCubbyId;
      const cubby = activeCubbyId ? get().cubbies.find((c) => c.id === activeCubbyId) : null;
      const stillValid = cubby && cubby.connectionId === slot.current.connectionId;
      set({ activeConnectionId: sessionId, activeCubbyId: stillValid ? activeCubbyId : null });
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

    async setConnectionColor(sessionId, color, colorStyle) {
      const slot = get().connections[sessionId];
      if (!slot) return;
      set((s) => ({
        connections: patchSlot(s.connections, sessionId, { color, colorStyle }),
      }));

      const savedConnectionId = slot.current.connectionId;
      if (!savedConnectionId) return; // ad-hoc — color just lives on the slot above
      const saved = get().savedConnections.find((c) => c.id === savedConnectionId);
      if (!saved) return;
      try {
        await api.saveConnection({ ...saved, color, colorStyle });
        await get().loadSavedConnections();
      } catch (err) {
        console.error("failed to persist connection color:", errorMessage(err));
      }
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
      void switchActiveTab(owner.connectionId, id).then((switched) => {
        if (switched && owner.tab.source) {
          rememberDatabaseObject(
            owner.connectionId,
            owner.tab.source.schema,
            owner.tab.source.table,
          );
        }
      });
    },

    navigateBack() {
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      if (!connectionId || !slot) return;
      const target = popValidTabId(slot.navBack, slot);
      if (!target.id) {
        // Nothing usable, but still drop whatever stale entries were in the
        // way so the next attempt doesn't re-scan them.
        if (target.stack.length !== slot.navBack.length) {
          set((s) => ({
            connections: patchSlot(s.connections, connectionId, { navBack: target.stack }),
          }));
        }
        return;
      }
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, {
          navBack: target.stack,
          navForward: slot.activeTabId
            ? [...slot.navForward, slot.activeTabId].slice(-MAX_NAV_HISTORY)
            : slot.navForward,
        }),
      }));
      void switchActiveTab(connectionId, target.id, { isHistoryNav: true });
    },

    navigateForward() {
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      if (!connectionId || !slot) return;
      const target = popValidTabId(slot.navForward, slot);
      if (!target.id) {
        if (target.stack.length !== slot.navForward.length) {
          set((s) => ({
            connections: patchSlot(s.connections, connectionId, { navForward: target.stack }),
          }));
        }
        return;
      }
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, {
          navForward: target.stack,
          navBack: slot.activeTabId
            ? [...slot.navBack, slot.activeTabId].slice(-MAX_NAV_HISTORY)
            : slot.navBack,
        }),
      }));
      void switchActiveTab(connectionId, target.id, { isHistoryNav: true });
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

    async runTab(id, sqlOverride, opts) {
      const owner = findTabOwner(get().connections, id);
      if (!owner || owner.tab.running) return;
      const { connectionId, tab } = owner;
      const sqlToRun = sqlOverride ?? tab.sql;
      const silent = opts?.silent ?? false;
      // An explicit Run starts over at the first page; a background refresh
      // stays on the page the user is looking at.
      const page = opts?.page ?? (silent ? tab.page ?? 0 : 0);

      if (tabHasPendingEdits(tab)) {
        // A silent background refresh (Cmd/Ctrl+R, the Refresh button) never
        // has a reason to clobber uncommitted edits with a confirm prompt the
        // user didn't ask for — just skip it this round.
        if (silent) return;
        const ok = await requestConfirm(
          `"${tab.title}" has unsaved changes. Refresh and lose them?`,
          "Refresh",
        );
        if (!ok) return;
      }

      if (silent) set({ silentRefreshTabId: id });
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
                  ...(t.kind === "query" ? { page } : {}),
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
        const result = await api.runQuery(slot.sessionId, sqlToRun, page);
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
        if (silent && get().silentRefreshTabId === id) set({ silentRefreshTabId: null });
        // Reflect the just-logged query in the history panel if it's open.
        if (get().historyOpen) void get().refreshHistory();
      }
    },

    async setQueryPage(tabId, page) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner || owner.tab.running) return;
      const next = Math.max(0, page);
      if (next === (owner.tab.page ?? 0)) return;
      await get().runTab(tabId, undefined, { page: next });
    },

    async refreshActive() {
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      const tasks: Promise<void>[] = [get().refreshSchema()];
      const activeTab = slot?.tabs.find((t) => t.id === slot.activeTabId);
      if (activeTab?.hasRun) tasks.push(get().runTab(activeTab.id, undefined, { silent: true }));
      await Promise.all(tasks);
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
        if (await switchActiveTab(connectionId, existing.id)) {
          rememberDatabaseObject(connectionId, schema, table);
        }
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
      rememberDatabaseObject(connectionId, schema, table);
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
        if (await switchActiveTab(connectionId, existing.id)) {
          rememberDatabaseObject(connectionId, schema, table);
        }
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
        return;
      }
      rememberDatabaseObject(connectionId, schema, table);
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
      const sort =
        tab.sortColumn != null ? { column: tab.sortColumn, desc: tab.sortDesc ?? false } : null;
      const sql = await tableSql(
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        filter.trim() || null,
        0,
        sort,
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

      await performRowDeletion(
        connectionId,
        tabId,
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        pkCols,
        [rowIndex],
      );
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

      await performRowDeletion(
        connectionId,
        tabId,
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        pkCols,
        [...new Set(rowIndices)],
      );
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
      const sort =
        tab.sortColumn != null ? { column: tab.sortColumn, desc: tab.sortDesc ?? false } : null;
      const sql = await tableSql(
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        tab.filter?.trim() || null,
        next,
        sort,
      );
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) => (t.id === tabId ? { ...t, sql, page: next } : t)),
        ),
      }));
      await get().runTab(tabId);
    },

    async setTableSort(tabId, column, desc) {
      const owner = findTabOwner(get().connections, tabId);
      if (!owner || owner.tab.running) return;
      const { connectionId, slot, tab } = owner;
      if (!tab.source) return;
      if (tab.sortColumn === column && (tab.sortDesc ?? false) === desc) return;
      // Sorting changes which rows land on which page, so — like changing
      // the filter — this always resets back to the first page.
      const sql = await tableSql(
        slot.sessionId,
        tab.source.schema,
        tab.source.table,
        tab.filter?.trim() || null,
        0,
        column != null ? { column, desc } : null,
      );
      set((s) => ({
        connections: mapSlotTabs(s.connections, connectionId, (tabs) =>
          tabs.map((t) =>
            t.id === tabId ? { ...t, sql, page: 0, sortColumn: column, sortDesc: desc } : t,
          ),
        ),
      }));
      await get().runTab(tabId);
    },

    toggleHistory() {
      const next = !get().historyOpen;
      // History, Saved Queries, AI, and Cubbies share one slot on the right
      // edge of the window — opening one closes the others rather than
      // stacking on top of each other. Closing (next === false) only touches
      // this panel's own flag.
      set(
        next
          ? { historyOpen: true, savedQueriesOpen: false, aiPanelOpen: false, cubbiesOpen: false }
          : { historyOpen: false },
      );
      if (next) void get().refreshHistory();
    },

    toggleCommandPalette() {
      set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen }));
    },

    closeCommandPalette() {
      set({ commandPaletteOpen: false });
    },

    toggleAiPanel() {
      const next = !get().aiPanelOpen;
      // See `toggleHistory` — the right-edge panels are mutually exclusive.
      set(
        next
          ? { aiPanelOpen: true, historyOpen: false, savedQueriesOpen: false, cubbiesOpen: false }
          : { aiPanelOpen: false },
      );
      if (!next) return;
      if (!get().aiConfig) void get().loadAiConfig();

      // "Reopen where I left off": if this connection has a saved-chat
      // identity and nothing's loaded into the panel yet, auto-resume its
      // most recently used chat, if it has one.
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      const savedConnectionId = slot?.current.connectionId ?? null;
      if (slot && savedConnectionId && slot.aiMessages.length === 0 && !slot.aiChatId) {
        void api
          .listAiChats(savedConnectionId)
          .then((chats) => {
            if (chats.length > 0) void get().openAiChat(chats[0].id);
          })
          .catch((err) => console.error("failed to auto-resume AI chat:", errorMessage(err)));
      }
    },

    toggleAiHistoryView() {
      const next = !get().aiHistoryView;
      set({ aiHistoryView: next });
      if (next) void get().loadAiChats();
    },

    async loadAiChats() {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      const savedConnectionId = slot?.current.connectionId ?? null;
      if (!savedConnectionId) {
        set((s) => ({ connections: patchSlot(s.connections, connectionId, { aiChats: [] }) }));
        return;
      }
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, { aiChatsLoading: true }),
      }));
      try {
        const aiChats = await api.listAiChats(savedConnectionId);
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, { aiChats, aiChatsLoading: false }),
        }));
      } catch (err) {
        console.error("failed to load AI chats:", errorMessage(err));
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, { aiChatsLoading: false }),
        }));
      }
    },

    newAiChat() {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, {
          aiMessages: [],
          aiChatId: null,
          aiError: null,
        }),
        aiHistoryView: false,
      }));
    },

    async openAiChat(id) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      try {
        const thread = await api.getAiChat(id);
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, {
            aiMessages: thread.messages,
            aiChatId: thread.id,
            aiError: null,
          }),
          aiHistoryView: false,
        }));
      } catch (err) {
        console.error("failed to open AI chat:", errorMessage(err));
      }
    },

    async renameAiChat(id, title) {
      const trimmed = title.trim();
      if (!trimmed) return;
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      try {
        await api.renameAiChat(id, trimmed);
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, (slot) => ({
            aiChats: slot.aiChats.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
          })),
        }));
      } catch (err) {
        console.error("failed to rename AI chat:", errorMessage(err));
      }
    },

    async deleteAiChat(id) {
      const ok = await requestConfirm("Delete this saved chat?", "Delete");
      if (!ok) return;
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      try {
        await api.deleteAiChat(id);
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, (slot) => ({
            aiChats: slot.aiChats.filter((c) => c.id !== id),
            // The deleted chat was open — fall back to a blank new chat
            // rather than leaving a dangling `aiChatId`.
            ...(slot.aiChatId === id ? { aiMessages: [], aiChatId: null, aiError: null } : {}),
          })),
        }));
      } catch (err) {
        console.error("failed to delete AI chat:", errorMessage(err));
      }
    },

    async sendAiMessage(text) {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMessage: AiMessage = { role: "user", content: trimmed };
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, (slot) => ({
          aiMessages: [...slot.aiMessages, userMessage],
        })),
      }));
      await get().runAiTurn(connectionId);
    },

    /** Re-runs the last turn after a failure. The user's message is still the
     *  final entry in `aiMessages` (a failed turn appends nothing), so this
     *  just runs it again rather than re-sending anything. */
    async retryAiMessage() {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      await get().runAiTurn(connectionId);
    },

    /** Drops the last reply and asks again, leaving the user's question in
     *  place. Only meaningful once a reply exists to replace. */
    async regenerateAiMessage() {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      const slot = get().connections[connectionId];
      if (!slot || slot.aiSending) return;
      const messages = slot.aiMessages;
      if (messages[messages.length - 1]?.role !== "assistant") return;
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, (current) => ({
          aiMessages: current.aiMessages.slice(0, -1),
        })),
      }));
      await get().runAiTurn(connectionId);
    },

    /** Abandons the in-flight turn. The provider request itself keeps running
     *  — a Tauri command can't be aborted partway, and the agent loop has no
     *  cancellation channel — so this bumps the turn token, which makes the
     *  eventual reply get dropped, and hands the panel straight back to the
     *  user. Tokens for that turn are still spent. */
    stopAiMessage() {
      const connectionId = get().activeConnectionId;
      if (!connectionId) return;
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, (slot) => ({
          aiTurnToken: slot.aiTurnToken + 1,
          aiSending: false,
          aiError: null,
        })),
      }));
    },

    async runAiTurn(connectionId) {
      const started = (get().connections[connectionId]?.aiTurnToken ?? 0) + 1;
      set((s) => ({
        connections: patchSlot(s.connections, connectionId, {
          aiSending: true,
          aiError: null,
          aiTurnToken: started,
        }),
      }));

      /** False once this turn has been stopped, or superseded by a newer one. */
      const stillCurrent = () =>
        get().connections[connectionId]?.aiTurnToken === started;

      const slot = get().connections[connectionId];
      if (!slot) return;
      // The active tab's table (if it's a table tab) so the AI knows what's
      // currently on screen — same info `openTableStructure`'s tab already
      // carries as `source`.
      const activeTab = slot.tabs.find((t) => t.id === slot.activeTabId);
      const activeTable = activeTab?.source ?? null;
      // `null` for an ad-hoc (never-saved) connection — there's no stable id
      // to save a chat against, so it stays exactly as ephemeral as before
      // this feature existed.
      const savedConnectionId = slot.current.connectionId;

      // The active cubby (if any and if it belongs to this connection) gets
      // its tables rendered in full detail in the system prompt — see
      // `PromptContext::cubby` on the backend. Sent fresh on every turn,
      // same as `schema` above.
      const activeCubby = get().activeCubbyId
        ? get().cubbies.find(
            (c) => c.id === get().activeCubbyId && c.connectionId === savedConnectionId,
          ) ?? null
        : null;
      const cubbyContext = activeCubby
        ? { name: activeCubby.name, tables: cubbyTableRefs(activeCubby) }
        : null;

      const persist = async (messages: AiMessage[]) => {
        if (!savedConnectionId) return;
        try {
          const thread = await api.upsertAiChat({
            id: get().connections[connectionId]?.aiChatId ?? "",
            connectionId: savedConnectionId,
            title: "",
            messages,
          });
          set((s) => ({
            connections: patchSlot(s.connections, connectionId, { aiChatId: thread.id }),
          }));
        } catch (err) {
          console.error("failed to save AI chat:", errorMessage(err));
        }
      };

      try {
        const result = await api.aiChat(
          slot.sessionId,
          slot.schema,
          activeTable,
          cubbyContext,
          slot.aiMessages,
        );
        // Stopped or superseded while the request was in flight — drop the
        // reply rather than have it appear after the user moved on.
        if (!stillCurrent()) return;
        const assistantMessage: AiMessage = {
          role: "assistant",
          content: result.reply,
          trace: result.trace,
        };
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, (current) => ({
            aiMessages: [...current.aiMessages, assistantMessage],
            aiSending: false,
          })),
        }));
        void persist([...slot.aiMessages, assistantMessage]);
      } catch (err) {
        if (!stillCurrent()) return;
        // Held beside the thread, not appended to it: `aiMessages` is both
        // what gets saved and what gets replayed to the model, and neither
        // should contain a failure the model never actually said.
        set((s) => ({
          connections: patchSlot(s.connections, connectionId, {
            aiSending: false,
            aiError: errorMessage(err),
          }),
        }));
      }
    },

    async loadAiConfig() {
      try {
        const aiConfig = await api.getAiConfig();
        set({ aiConfig });
      } catch (err) {
        console.error("failed to load AI config:", errorMessage(err));
      }
    },

    async saveAiProvider(provider) {
      const aiConfig = await api.saveAiProvider(provider);
      set({ aiConfig });
    },

    async saveAiConfig(provider, apiKey) {
      const aiConfig = await api.saveAiConfig(provider, apiKey);
      set({ aiConfig });
    },

    async clearAiConfig(provider) {
      const name =
        provider === "openai"
          ? "OpenAI"
          : provider === "codex"
            ? "Codex"
            : provider === "claudeCode"
              ? "Claude Code"
              : "Anthropic";
      const ok = await requestConfirm(`Remove the saved ${name} API key?`, "Remove key");
      if (!ok) return;
      const aiConfig = await api.clearAiConfig(provider);
      set({ aiConfig });
    },

    async startCodexLogin() {
      if (!(await ensureAiTermsAccepted())) return;
      await api.startCodexLogin();
      // The browser callback completes inside the Codex CLI process. Poll its
      // public account status so Settings updates without ever handling a token.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const aiConfig = await api.getAiConfig();
        set({ aiConfig });
        if (aiConfig.codexAuthenticated) return;
      }
      throw new Error("ChatGPT sign-in did not finish in time. You can try again.");
    },

    async startClaudeCodeLogin() {
      if (!(await ensureAiTermsAccepted())) return;
      await api.startClaudeCodeLogin();
      // Same shape as `startCodexLogin`: the browser callback completes
      // inside the Claude Code CLI process, so Settings polls its public
      // auth status instead of ever handling a token.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const aiConfig = await api.getAiConfig();
        set({ aiConfig });
        if (aiConfig.claudeCodeAuthenticated) return;
      }
      throw new Error("Claude sign-in did not finish in time. You can try again.");
    },

    async logoutCodex() {
      const ok = await requestConfirm("Sign out of your Codex ChatGPT account?", "Sign out");
      if (!ok) return;
      await api.logoutCodex();
      set({ aiConfig: await api.getAiConfig() });
    },

    async logoutClaudeCode() {
      const ok = await requestConfirm("Sign out of your Claude Code account?", "Sign out");
      if (!ok) return;
      await api.logoutClaudeCode();
      set({ aiConfig: await api.getAiConfig() });
    },

    async saveAiModel(provider, model, supportsEffort) {
      const aiConfig = await api.saveAiModel(provider, model, supportsEffort);
      set({ aiConfig });
    },

    async saveAiReasoningEffort(provider, effort) {
      const aiConfig = await api.saveAiReasoningEffort(provider, effort);
      set({ aiConfig });
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
      // See `toggleHistory` — the right-edge panels are mutually exclusive.
      set(
        next
          ? { savedQueriesOpen: true, historyOpen: false, aiPanelOpen: false, cubbiesOpen: false }
          : { savedQueriesOpen: false },
      );
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

    async loadCubbies() {
      try {
        const list = await api.listCubbies();
        set({ cubbies: list });
      } catch (err) {
        console.error("failed to load cubbies:", errorMessage(err));
      }
    },

    toggleCubbies() {
      const next = !get().cubbiesOpen;
      // See `toggleHistory` — History, Saved Queries, AI, and Cubbies share
      // one slot on the right edge of the window.
      set(
        next
          ? { cubbiesOpen: true, historyOpen: false, savedQueriesOpen: false, aiPanelOpen: false }
          : { cubbiesOpen: false },
      );
    },

    async createCubby(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const connectionId = get().activeConnectionId;
      const slot = connectionId ? get().connections[connectionId] : null;
      const savedConnectionId = slot?.current.connectionId ?? null;
      if (!savedConnectionId) {
        get().showToast("Save this connection before creating a cubby for it.", "error");
        return;
      }
      try {
        const saved = await api.saveCubby({
          id: "",
          name: trimmed,
          connectionId: savedConnectionId,
          entries: [],
          createdAt: 0,
          updatedAt: 0,
        });
        set((s) => ({ cubbies: [saved, ...s.cubbies], activeCubbyId: saved.id }));
      } catch (err) {
        console.error("failed to create cubby:", errorMessage(err));
      }
    },

    async renameCubby(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const existing = get().cubbies.find((c) => c.id === id);
      if (!existing) return;
      try {
        const saved = await api.saveCubby({ ...existing, name: trimmed });
        set((s) => ({ cubbies: s.cubbies.map((c) => (c.id === id ? saved : c)) }));
      } catch (err) {
        console.error("failed to rename cubby:", errorMessage(err));
      }
    },

    async deleteCubbyById(id) {
      const ok = await requestConfirm(
        "Delete this cubby? The tables, queries, and chats it points to are not affected.",
        "Delete",
      );
      if (!ok) return;
      try {
        await api.deleteCubby(id);
        set((s) => ({
          cubbies: s.cubbies.filter((c) => c.id !== id),
          activeCubbyId: s.activeCubbyId === id ? null : s.activeCubbyId,
        }));
      } catch (err) {
        console.error("failed to delete cubby:", errorMessage(err));
      }
    },

    async openCubby(id) {
      const cubby = get().cubbies.find((c) => c.id === id);
      if (!cubby) return;

      // A cubby only makes sense against its own connection — reuse an
      // already-open slot if there is one, otherwise connect to it fresh
      // (same saved-connection record the connection screen would use).
      let targetSessionId = Object.keys(get().connections).find(
        (sessionId) => get().connections[sessionId]?.current.connectionId === cubby.connectionId,
      );
      if (!targetSessionId) {
        const saved = get().savedConnections.find((c) => c.id === cubby.connectionId);
        if (!saved) {
          get().showToast(`Can't find "${cubby.name}"'s saved connection.`, "error");
          return;
        }
        try {
          await get().connectTo({ params: saved.params, name: saved.name, id: saved.id });
        } catch (err) {
          get().showToast(`Couldn't connect to "${saved.name}": ${errorMessage(err)}`, "error");
          return;
        }
        targetSessionId = Object.keys(get().connections).find(
          (sessionId) => get().connections[sessionId]?.current.connectionId === cubby.connectionId,
        );
        if (!targetSessionId) return;
      }
      if (get().activeConnectionId !== targetSessionId) {
        get().switchConnection(targetSessionId);
      }

      // "Open onto a clean slate" (Settings → General). Done as one bulk
      // clear with a single up-front confirmation rather than a loop over
      // `closeTab`, which would ask about each dirty tab separately. Runs
      // before `activeCubbyId` is set so a cancel leaves everything — tabs
      // and the previously active cubby — exactly as it was.
      if (get().closeTabsOnCubbyOpen) {
        const dirty = (get().connections[targetSessionId]?.tabs ?? []).filter(tabHasPendingEdits);
        if (dirty.length > 0) {
          const ok = await requestConfirm(
            dirty.length === 1
              ? `"${dirty[0].title}" has unsaved changes. Close it without saving?`
              : `${dirty.length} tabs have unsaved changes. Close them without saving?`,
            "Close",
          );
          if (!ok) return;
        }
        set((s) => ({
          connections: patchSlot(s.connections, targetSessionId, {
            tabs: [],
            activeTabId: null,
            navBack: [],
            navForward: [],
          }),
        }));
      }

      // The panel deliberately stays open — opening a cubby is often one of
      // several things done here in a row (open, prune an entry, switch to
      // another), and closing it out from under the user after every open
      // would make the panel feel like a one-shot dialog.
      set({ activeCubbyId: id });

      const slot = get().connections[targetSessionId];
      if (!slot) return;

      // Every tab is built up front and added in ONE state update, then a
      // single tab is focused at the end. Delegating to
      // `openSelectTop`/`openTableStructure`/... in a loop is the obvious
      // implementation but each of those focuses the tab it just made, so
      // opening an N-entry cubby visibly flipped the workspace through all N
      // panes on the way in — mounting and discarding each results grid in
      // turn. This does the same work with one re-render and one focus.
      const created: QueryTab[] = [];
      /** The tab the first entry resolves to — newly built or already open —
       *  so "open" reliably lands somewhere in the cubby either way. */
      let focusTabId: string | null = null;
      let chatToOpen: string | null = null;

      const find = (match: (t: QueryTab) => boolean) =>
        slot.tabs.find(match) ?? created.find(match) ?? null;
      const take = (existing: QueryTab | null, build: () => QueryTab) => {
        const tab = existing ?? build();
        if (!existing) created.push(tab);
        focusTabId ??= tab.id;
      };

      for (const entry of cubby.entries) {
        switch (entry.kind) {
          case "savedQuery": {
            const query = get().savedQueries.find((q) => q.id === entry.savedQueryId);
            if (!query) break;
            take(
              find((t) => t.savedQueryId === query.id),
              () =>
                makeTab({
                  kind: "query",
                  title: query.name,
                  sql: query.sql,
                  savedQueryId: query.id,
                }),
            );
            break;
          }
          case "table": {
            const existing = find(
              (t) =>
                t.kind === "table" &&
                t.source?.schema === entry.schema &&
                t.source?.table === entry.table,
            );
            const sql = existing
              ? ""
              : await tableSql(slot.sessionId, entry.schema, entry.table, null, 0);
            take(existing, () =>
              makeTab({
                kind: "table",
                title: entry.table,
                sql,
                source: { schema: entry.schema, table: entry.table },
                page: 0,
              }),
            );
            rememberDatabaseObject(targetSessionId, entry.schema, entry.table);
            break;
          }
          case "structure": {
            take(
              find(
                (t) =>
                  t.kind === "structure" &&
                  t.source?.schema === entry.schema &&
                  t.source?.table === entry.table,
              ),
              () =>
                makeTab({
                  kind: "structure",
                  title: `${entry.table} (structure)`,
                  source: { schema: entry.schema, table: entry.table },
                }),
            );
            rememberDatabaseObject(targetSessionId, entry.schema, entry.table);
            break;
          }
          case "function": {
            take(
              find(
                (t) =>
                  t.kind === "function" &&
                  t.objectRef?.schema === entry.schema &&
                  t.objectRef?.name === entry.name,
              ),
              () =>
                makeTab({
                  kind: "function",
                  title: `${entry.name}()`,
                  objectRef: {
                    schema: entry.schema,
                    name: entry.name,
                    oid: entry.oid ?? undefined,
                  },
                }),
            );
            break;
          }
          case "sequence": {
            take(
              find(
                (t) =>
                  t.kind === "sequence" &&
                  t.objectRef?.schema === entry.schema &&
                  t.objectRef?.name === entry.name,
              ),
              () =>
                makeTab({
                  kind: "sequence",
                  title: entry.name,
                  objectRef: { schema: entry.schema, name: entry.name },
                }),
            );
            break;
          }
          case "chat":
            chatToOpen = entry.chatId;
            break;
        }
      }

      if (created.length > 0 || focusTabId) {
        set((s) => ({
          connections: patchSlot(s.connections, targetSessionId, (cur) => ({
            tabs: created.length > 0 ? [...cur.tabs, ...created] : cur.tabs,
            activeTabId: focusTabId ?? cur.activeTabId,
          })),
        }));
      }

      // Results load after the layout has settled, so rows filling in never
      // moves which tab is on screen.
      for (const tab of created) {
        if (tab.kind === "table") await get().runTab(tab.id);
      }
      if (chatToOpen) await get().openAiChat(chatToOpen);
    },

    closeCubby() {
      set({ activeCubbyId: null });
    },

    async addEntryToCubby(cubbyId, entry) {
      const cubby = get().cubbies.find((c) => c.id === cubbyId);
      if (!cubby) return;
      if (cubby.entries.some((e) => cubbyEntryEquals(e, entry))) {
        get().showToast(`Already in "${cubby.name}".`);
        return;
      }
      try {
        const saved = await api.saveCubby({ ...cubby, entries: [...cubby.entries, entry] });
        set((s) => ({ cubbies: s.cubbies.map((c) => (c.id === cubbyId ? saved : c)) }));
        get().showToast(`Added to "${cubby.name}".`);
      } catch (err) {
        console.error("failed to add to cubby:", errorMessage(err));
      }
    },

    async removeEntryFromCubby(cubbyId, entry) {
      const cubby = get().cubbies.find((c) => c.id === cubbyId);
      if (!cubby) return;
      try {
        const saved = await api.saveCubby({
          ...cubby,
          entries: cubby.entries.filter((e) => !cubbyEntryEquals(e, entry)),
        });
        set((s) => ({ cubbies: s.cubbies.map((c) => (c.id === cubbyId ? saved : c)) }));
      } catch (err) {
        console.error("failed to remove from cubby:", errorMessage(err));
      }
    },

    async removeTableFromCubby(cubbyId, schema, table) {
      const cubby = get().cubbies.find((c) => c.id === cubbyId);
      if (!cubby) return;
      const entries = cubby.entries.filter(
        (e) =>
          !(
            (e.kind === "table" || e.kind === "structure") &&
            e.schema === schema &&
            e.table === table
          ),
      );
      if (entries.length === cubby.entries.length) return;
      try {
        const saved = await api.saveCubby({ ...cubby, entries });
        set((s) => ({ cubbies: s.cubbies.map((c) => (c.id === cubbyId ? saved : c)) }));
      } catch (err) {
        console.error("failed to remove from cubby:", errorMessage(err));
      }
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

    setSidebarRowHeight(height) {
      applySidebarRowHeight(height);
      set({ sidebarRowHeight: height });
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

    setCloseTabsOnCubbyOpen(enabled) {
      saveCloseTabsOnCubbyOpen(enabled);
      set({ closeTabsOnCubbyOpen: enabled });
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

    showToast(message, kind = "success") {
      set({ toast: { message, kind } });
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        set({ toast: null });
        toastTimer = null;
      }, 4000);
    },

    openSettings(section) {
      set({ settingsOpen: true, settingsSection: section ?? null });
    },

    closeSettings() {
      set({ settingsOpen: false });
    },

    openEditConnection(sessionId) {
      set({ editConnectionSessionId: sessionId });
    },

    closeEditConnection() {
      set({ editConnectionSessionId: null });
    },
  };
});

// Stable empty fallbacks so selectors below don't create a new array/object
// reference (and trigger a needless re-render) every time there's no active
// connection.
const EMPTY_TABS: QueryTab[] = [];
const EMPTY_SCHEMA: SchemaNode[] = [];
const EMPTY_AI_MESSAGES: AiMessage[] = [];
const EMPTY_AI_CHATS: AiChatSummary[] = [];
const EMPTY_CUBBIES: Cubby[] = [];

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

/** The active connection's AI chat thread. Empty when nothing is connected. */
export function useActiveAiMessages(): AiMessage[] {
  return useStore((s) =>
    s.activeConnectionId
      ? s.connections[s.activeConnectionId]?.aiMessages ?? EMPTY_AI_MESSAGES
      : EMPTY_AI_MESSAGES,
  );
}

/** True while an `aiChat` call is in flight for the active connection. */
export function useActiveAiSending(): boolean {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.aiSending ?? false : false,
  );
}

export function useActiveAiError(): string | null {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.aiError ?? null : null,
  );
}

/** Which saved chat the active connection's current thread is, if any. */
export function useActiveAiChatId(): string | null {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.aiChatId ?? null : null,
  );
}

/** The active connection's saved-chat list, for the AI panel's History view. */
export function useActiveAiChats(): AiChatSummary[] {
  return useStore((s) =>
    s.activeConnectionId
      ? s.connections[s.activeConnectionId]?.aiChats ?? EMPTY_AI_CHATS
      : EMPTY_AI_CHATS,
  );
}

export function useActiveAiChatsLoading(): boolean {
  return useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.aiChatsLoading ?? false : false,
  );
}

/** Whether the active connection has a stable id to save chats against —
 *  `false` for ad-hoc (never-saved) connections, which keep AI chat fully
 *  functional but ephemeral, same as before this feature existed. */
export function useActiveConnectionCanSaveChats(): boolean {
  return useStore((s) =>
    s.activeConnectionId
      ? Boolean(s.connections[s.activeConnectionId]?.current.connectionId)
      : false,
  );
}

/** The currently open cubby (across any connection — `openCubby` already
 *  guarantees it belongs to the active one, and `switchConnection` clears it
 *  otherwise), or `null` if none is open. */
export function useActiveCubby(): Cubby | null {
  return useStore((s) =>
    s.activeCubbyId ? s.cubbies.find((c) => c.id === s.activeCubbyId) ?? null : null,
  );
}

/** The active connection's own cubbies (a cubby belongs to exactly one saved
 *  connection) — for the Cubbies panel's list. Empty for an ad-hoc
 *  connection, which has no stable id for a cubby to be scoped to.
 *
 *  The filter itself is a `useMemo`, not part of the Zustand selector — see
 *  `useActiveSchemaLoading`'s comment above: a selector that allocates a new
 *  array on every call defeats `useSyncExternalStore`'s reference-equality
 *  snapshot check and re-renders on every unrelated store update. `cubbies`
 *  and `savedConnectionId` below are each selected directly (stable unless
 *  they actually change), so only the derived list needs memoizing. */
export function useConnectionCubbies(): Cubby[] {
  const cubbies = useStore((s) => s.cubbies);
  const savedConnectionId = useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.current.connectionId ?? null : null,
  );
  return useMemo(() => {
    if (!savedConnectionId) return EMPTY_CUBBIES;
    const list = cubbies.filter((c) => c.connectionId === savedConnectionId);
    return list.length > 0 ? list : EMPTY_CUBBIES;
  }, [cubbies, savedConnectionId]);
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
