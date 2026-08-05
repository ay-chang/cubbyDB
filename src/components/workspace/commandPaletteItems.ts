import type { FuzzyMatch } from "../../lib/fuzzyMatch";
import { bestMatch } from "../../lib/fuzzyMatch";
import type { KeybindingId } from "../../lib/keybindings";
import type {
  ConnectionSlot,
  QueryTab,
  RecentDatabaseObject,
  SettingsSection,
  TabKind,
} from "../../state/store";
import type { HistoryEntry, SavedQuery, TableKind } from "../../types";

export type PaletteScope = "all" | "tables" | "columns" | "scripts" | "history";

export const PALETTE_SCOPES: Array<{
  id: PaletteScope;
  label: string;
  placeholder: string;
}> = [
  { id: "all", label: "All", placeholder: "Search CubbyDB…" },
  { id: "tables", label: "Tables", placeholder: "Search tables…" },
  { id: "columns", label: "Columns", placeholder: "Search columns…" },
  { id: "scripts", label: "Scripts", placeholder: "Search saved scripts…" },
  { id: "history", label: "History", placeholder: "Search query history…" },
];

type Match = FuzzyMatch & { candidate: number };

interface BaseItem {
  id: string;
  match: Match;
}

export type PaletteActionId =
  | "new-query"
  | "refresh"
  | "ask-ai"
  | "saved-queries"
  | "query-history";

export type PaletteItem =
  | (BaseItem & {
      kind: "action";
      action: PaletteActionId;
      label: string;
      description: string;
      keybindingId?: KeybindingId;
    })
  | (BaseItem & {
      kind: "setting";
      section: SettingsSection;
      label: string;
      description: string;
      keybindingId?: KeybindingId;
    })
  | (BaseItem & {
      kind: "connection";
      sessionId: string;
      connectionName: string;
      database: string | null;
      host: string | null;
      active: boolean;
    })
  | (BaseItem & {
      kind: "tab";
      sessionId: string;
      connectionName: string;
      tab: QueryTab;
      active: boolean;
    })
  | (BaseItem & {
      kind: "table";
      sessionId: string;
      connectionName: string;
      schema: string;
      table: string;
      tableKind: TableKind;
      estimatedRows: number | null;
    })
  | (BaseItem & {
      kind: "column";
      sessionId: string;
      connectionName: string;
      schema: string;
      table: string;
      column: string;
      dataType: string;
    })
  | (BaseItem & {
      kind: "script";
      query: SavedQuery;
    })
  | (BaseItem & {
      kind: "history";
      entry: HistoryEntry;
    });

export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

const NO_MATCH: Match = { score: 0, indices: [], candidate: -1 };
const PER_GROUP_LIMIT = 16;
const EMPTY_TAB_LIMIT = 8;
const EMPTY_HISTORY_LIMIT = 6;

const ACTIONS: Array<{
  action: PaletteActionId;
  label: string;
  description: string;
  keybindingId?: KeybindingId;
  showWhenEmpty?: boolean;
}> = [
  {
    action: "new-query",
    label: "New query",
    description: "Open a query tab in the current connection",
    keybindingId: "workspace.newQuery",
    showWhenEmpty: true,
  },
  {
    action: "refresh",
    label: "Refresh schema and data",
    description: "Reload the schema and active tab",
    keybindingId: "workspace.refresh",
    showWhenEmpty: true,
  },
  {
    action: "ask-ai",
    label: "Ask AI",
    description: "Open the read-only database assistant",
    showWhenEmpty: true,
  },
  {
    action: "saved-queries",
    label: "Show saved queries",
    description: "Open the saved-query drawer",
  },
  {
    action: "query-history",
    label: "Show query history",
    description: "Open recent query executions",
  },
];

const SETTINGS: Array<{
  section: SettingsSection;
  label: string;
  description: string;
  keybindingId?: KeybindingId;
  showWhenEmpty?: boolean;
}> = [
  {
    section: "general",
    label: "Open Settings",
    description: "General application settings",
    keybindingId: "workspace.openSettings",
    showWhenEmpty: true,
  },
  {
    section: "appearance",
    label: "Appearance settings",
    description: "Theme, table, sidebar, and editor appearance",
  },
  {
    section: "aiAssistant",
    label: "AI Assistant settings",
    description: "Provider, model, and reasoning configuration",
  },
  {
    section: "shortcuts",
    label: "Keyboard Shortcut settings",
    description: "Review and customize keyboard commands",
  },
];

function scoreItem<T extends PaletteItem>(
  item: Omit<T, "match">,
  query: string,
  candidates: string[],
): { item: T; score: number } | null {
  const match = bestMatch(query, candidates);
  if (!match) return null;
  return { item: { ...item, match } as T, score: match.score };
}

function sortAndLimit<T extends PaletteItem>(
  scored: Array<{ item: T; score: number }>,
  query: string,
  limit = PER_GROUP_LIMIT,
): T[] {
  if (query) scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ item }) => item);
}

function connectionMeta(slot: ConnectionSlot): { database: string | null; host: string | null } {
  return {
    database: slot.params.database?.trim() || null,
    host: slot.params.host?.trim() || null,
  };
}

function tabKindLabel(kind: TabKind): string {
  switch (kind) {
    case "table":
      return "Table";
    case "structure":
      return "Structure";
    case "function":
      return "Function";
    case "sequence":
      return "Sequence";
    case "query":
      return "Query";
  }
}

function buildActionItems(query: string): PaletteItem[] {
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const definition of ACTIONS) {
    if (!query && !definition.showWhenEmpty) continue;
    const result = scoreItem<Extract<PaletteItem, { kind: "action" }>>(
      {
        id: `action:${definition.action}`,
        kind: "action",
        action: definition.action,
        label: definition.label,
        description: definition.description,
        keybindingId: definition.keybindingId,
      },
      query,
      [definition.label, definition.description],
    );
    if (result) scored.push(result);
  }
  for (const definition of SETTINGS) {
    if (!query && !definition.showWhenEmpty) continue;
    const result = scoreItem<Extract<PaletteItem, { kind: "setting" }>>(
      {
        id: `setting:${definition.section}`,
        kind: "setting",
        section: definition.section,
        label: definition.label,
        description: definition.description,
        keybindingId: definition.keybindingId,
      },
      query,
      [definition.label, definition.description, "settings preferences"],
    );
    if (result) scored.push(result);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ item }) => item);
}

function buildTabItems(
  slots: ConnectionSlot[],
  activeConnectionId: string | null,
  query: string,
): PaletteItem[] {
  const scored: Array<{ item: Extract<PaletteItem, { kind: "tab" }>; score: number }> = [];
  for (const slot of slots) {
    for (const tab of slot.tabs) {
      const result = scoreItem<Extract<PaletteItem, { kind: "tab" }>>(
        {
          id: `tab:${slot.sessionId}:${tab.id}`,
          kind: "tab",
          sessionId: slot.sessionId,
          connectionName: slot.current.name,
          tab,
          active:
            slot.sessionId === activeConnectionId && tab.id === slot.activeTabId,
        },
        query,
        [tab.title, tab.sql, tabKindLabel(tab.kind), slot.current.name],
      );
      if (result) scored.push(result);
    }
  }
  return sortAndLimit(scored, query, query ? PER_GROUP_LIMIT : EMPTY_TAB_LIMIT);
}

function buildConnectionItems(
  slots: ConnectionSlot[],
  activeConnectionId: string | null,
  query: string,
): PaletteItem[] {
  const scored: Array<{
    item: Extract<PaletteItem, { kind: "connection" }>;
    score: number;
  }> = [];
  for (const slot of slots) {
    const meta = connectionMeta(slot);
    const result = scoreItem<Extract<PaletteItem, { kind: "connection" }>>(
      {
        id: `connection:${slot.sessionId}`,
        kind: "connection",
        sessionId: slot.sessionId,
        connectionName: slot.current.name,
        database: meta.database,
        host: meta.host,
        active: slot.sessionId === activeConnectionId,
      },
      query,
      [slot.current.name, meta.database ?? "", meta.host ?? "", "connection database"],
    );
    if (result) scored.push(result);
  }
  return sortAndLimit(scored, query);
}

function buildTableAndColumnItems(
  slots: ConnectionSlot[],
  query: string,
  includeTables: boolean,
  includeColumns: boolean,
): { tables: PaletteItem[]; columns: PaletteItem[] } {
  const tables: Array<{ item: Extract<PaletteItem, { kind: "table" }>; score: number }> = [];
  const columns: Array<{ item: Extract<PaletteItem, { kind: "column" }>; score: number }> = [];

  for (const slot of slots) {
    for (const schema of slot.schema) {
      for (const table of schema.tables) {
        if (includeTables) {
          const result = scoreItem<Extract<PaletteItem, { kind: "table" }>>(
            {
              id: `table:${slot.sessionId}:${schema.name}.${table.name}`,
              kind: "table",
              sessionId: slot.sessionId,
              connectionName: slot.current.name,
              schema: schema.name,
              table: table.name,
              tableKind: table.kind,
              estimatedRows: table.estimatedRows,
            },
            query,
            [table.name, `${schema.name}.${table.name}`, slot.current.name],
          );
          if (result) tables.push(result);
        }
        if (!query || !includeColumns) continue;
        for (const column of table.columns) {
          const result = scoreItem<Extract<PaletteItem, { kind: "column" }>>(
            {
              id: `column:${slot.sessionId}:${schema.name}.${table.name}.${column.name}`,
              kind: "column",
              sessionId: slot.sessionId,
              connectionName: slot.current.name,
              schema: schema.name,
              table: table.name,
              column: column.name,
              dataType: column.dataType,
            },
            query,
            [column.name, `${table.name}.${column.name}`, `${schema.name}.${table.name}.${column.name}`],
          );
          if (result) columns.push(result);
        }
      }
    }
  }

  if (!query) {
    tables.sort((a, b) => {
      const left = a.item;
      const right = b.item;
      return (
        left.connectionName.localeCompare(right.connectionName) ||
        `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`)
      );
    });
  }
  return {
    tables: sortAndLimit(tables, query, query ? PER_GROUP_LIMIT : 40),
    columns: sortAndLimit(columns, query),
  };
}

function buildScriptItems(savedQueries: SavedQuery[], query: string): PaletteItem[] {
  const scored: Array<{ item: Extract<PaletteItem, { kind: "script" }>; score: number }> = [];
  for (const savedQuery of savedQueries) {
    const result = scoreItem<Extract<PaletteItem, { kind: "script" }>>(
      {
        id: `script:${savedQuery.id}`,
        kind: "script",
        query: savedQuery,
      },
      query,
      [savedQuery.name, savedQuery.sql],
    );
    if (result) scored.push(result);
  }
  return sortAndLimit(scored, query, query ? PER_GROUP_LIMIT : 40);
}

function buildHistoryItems(history: HistoryEntry[], query: string): PaletteItem[] {
  const scored: Array<{ item: Extract<PaletteItem, { kind: "history" }>; score: number }> = [];
  for (const [index, entry] of history.entries()) {
    const result = scoreItem<Extract<PaletteItem, { kind: "history" }>>(
      {
        id: `history:${entry.executedAt}:${index}`,
        kind: "history",
        entry,
      },
      query,
      [entry.sql, entry.connectionName ?? "", entry.success ? "successful" : "failed"],
    );
    if (result) scored.push(result);
  }
  return sortAndLimit(scored, query, query ? PER_GROUP_LIMIT : EMPTY_HISTORY_LIMIT);
}

function buildRecentObjectItems(
  recentObjects: RecentDatabaseObject[],
  slots: ConnectionSlot[],
): PaletteItem[] {
  const byId = new Map(slots.map((slot) => [slot.sessionId, slot]));
  return recentObjects.flatMap((recent) => {
    const slot = byId.get(recent.sessionId);
    const schema = slot?.schema.find((item) => item.name === recent.schema);
    const table = schema?.tables.find((item) => item.name === recent.table);
    if (!slot || !table) return [];
    return [{
      id: `recent:${recent.sessionId}:${recent.schema}.${recent.table}`,
      kind: "table" as const,
      sessionId: recent.sessionId,
      connectionName: slot.current.name,
      schema: recent.schema,
      table: recent.table,
      tableKind: table.kind,
      estimatedRows: table.estimatedRows,
      match: NO_MATCH,
    }];
  });
}

function group(id: string, label: string, items: PaletteItem[]): PaletteGroup[] {
  return items.length > 0 ? [{ id, label, items }] : [];
}

export function buildPaletteGroups(input: {
  scope: PaletteScope;
  query: string;
  slots: ConnectionSlot[];
  activeConnectionId: string | null;
  savedQueries: SavedQuery[];
  history: HistoryEntry[];
  recentObjects: RecentDatabaseObject[];
}): PaletteGroup[] {
  const query = input.query.trim();
  const { scope, slots } = input;

  if (scope === "tables") {
    return group(
      "tables",
      "Tables and views",
      buildTableAndColumnItems(slots, query, true, false).tables,
    );
  }
  if (scope === "columns") {
    return query
      ? group(
          "columns",
          "Columns",
          buildTableAndColumnItems(slots, query, false, true).columns,
        )
      : [];
  }
  if (scope === "scripts") {
    return group("scripts", "Saved queries", buildScriptItems(input.savedQueries, query));
  }
  if (scope === "history") {
    return group("history", "Recent query history", buildHistoryItems(input.history, query));
  }

  if (!query) {
    return [
      ...group("actions", "Actions", buildActionItems(query)),
      ...group("tabs", "Open tabs", buildTabItems(slots, input.activeConnectionId, query)),
      ...group(
        "connections",
        "Connections",
        buildConnectionItems(slots, input.activeConnectionId, query),
      ),
      ...group("recent", "Recent database objects", buildRecentObjectItems(input.recentObjects, slots)),
      ...group("history", "Recent query history", buildHistoryItems(input.history, query)),
    ];
  }

  const objects = buildTableAndColumnItems(slots, query, true, true);
  return [
    ...group("actions", "Actions and settings", buildActionItems(query)),
    ...group("tabs", "Open tabs", buildTabItems(slots, input.activeConnectionId, query)),
    ...group(
      "connections",
      "Connections",
      buildConnectionItems(slots, input.activeConnectionId, query),
    ),
    ...group("tables", "Tables and views", objects.tables),
    ...group("columns", "Columns", objects.columns),
    ...group("scripts", "Saved queries", buildScriptItems(input.savedQueries, query)),
    ...group("history", "Query history", buildHistoryItems(input.history, query)),
  ];
}

export function tabIcon(kind: TabKind): string {
  switch (kind) {
    case "table":
      return "▦";
    case "structure":
      return "▤";
    case "function":
      return "ƒ";
    case "sequence":
      return "#";
    case "query":
      return "◆";
  }
}
