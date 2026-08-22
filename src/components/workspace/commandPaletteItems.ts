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
import type { Cubby, SavedConnection, SavedQuery, TableKind } from "../../types";
import { SETTINGS_SECTIONS } from "../common/settingsSearch";

export type PaletteScope = "all" | "cubbies" | "tables" | "columns" | "scripts";

export const PALETTE_SCOPES: Array<{
  id: PaletteScope;
  label: string;
  placeholder: string;
}> = [
  { id: "all", label: "All", placeholder: "Search CubbyDB…" },
  { id: "tables", label: "Tables", placeholder: "Search tables…" },
  { id: "cubbies", label: "Cubbies", placeholder: "Search cubbies…" },
  { id: "columns", label: "Columns", placeholder: "Search columns…" },
  { id: "scripts", label: "Scripts", placeholder: "Search saved scripts…" },
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
      kind: "cubby";
      cubby: Cubby;
      /** Resolved from `cubby.connectionId` via `savedConnections` — a cubby
       *  doesn't carry a live session id the way a table/tab/connection item
       *  does, since opening one can connect fresh (see `openCubby`). */
      connectionName: string | null;
    });

export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

const NO_MATCH: Match = { score: 0, indices: [], candidate: -1 };
const PER_GROUP_LIMIT = 16;
const EMPTY_TAB_LIMIT = 8;

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
  tiebreak?: (a: T, b: T) => number,
): T[] {
  if (query) {
    scored.sort((a, b) => b.score - a.score || (tiebreak ? tiebreak(a.item, b.item) : 0));
  }
  return scored.slice(0, limit).map(({ item }) => item);
}

/** Sorts items on the active connection ahead of equally-scored matches from
 *  other connections, so e.g. searching "business" while on prod surfaces
 *  prod's `business` table before uat's or staging's. */
function activeConnectionFirst<T extends { sessionId: string }>(
  activeConnectionId: string | null,
): (a: T, b: T) => number {
  return (a, b) => {
    const aActive = a.sessionId === activeConnectionId;
    const bActive = b.sessionId === activeConnectionId;
    if (aActive === bActive) return 0;
    return aActive ? -1 : 1;
  };
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
    case "whatsnew":
      return "What's New";
    case "schemaCompare":
      return "Schema Compare";
    case "erDiagram":
      return "ER Diagram";
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
  for (const definition of SETTINGS_SECTIONS) {
    if (!query && definition.id !== "general") continue;
    const result = scoreItem<Extract<PaletteItem, { kind: "setting" }>>(
      {
        id: `setting:${definition.id}`,
        kind: "setting",
        section: definition.id,
        label: definition.id === "general" ? "Open Settings" : `${definition.label} settings`,
        description: definition.description,
        keybindingId: definition.id === "general" ? "workspace.openSettings" : undefined,
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

/** Exported for reuse by `AiTablePicker`'s attach-a-table search — the same
 *  fuzzy table/column matching the command palette itself uses. */
export function buildTableAndColumnItems(
  slots: ConnectionSlot[],
  activeConnectionId: string | null,
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
  const activeFirst = activeConnectionFirst<PaletteItem & { sessionId: string }>(activeConnectionId);
  return {
    tables: sortAndLimit(tables, query, query ? PER_GROUP_LIMIT : 40, activeFirst),
    columns: sortAndLimit(columns, query, PER_GROUP_LIMIT, activeFirst),
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

function buildCubbyItems(
  cubbies: Cubby[],
  savedConnections: SavedConnection[],
  query: string,
): PaletteItem[] {
  const scored: Array<{ item: Extract<PaletteItem, { kind: "cubby" }>; score: number }> = [];
  for (const cubby of cubbies) {
    const result = scoreItem<Extract<PaletteItem, { kind: "cubby" }>>(
      {
        id: `cubby:${cubby.id}`,
        kind: "cubby",
        cubby,
        connectionName: savedConnections.find((c) => c.id === cubby.connectionId)?.name ?? null,
      },
      query,
      [cubby.name],
    );
    if (result) scored.push(result);
  }
  if (!query) scored.sort((a, b) => b.item.cubby.updatedAt - a.item.cubby.updatedAt);
  return sortAndLimit(scored, query, query ? PER_GROUP_LIMIT : 40);
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
  recentObjects: RecentDatabaseObject[];
  cubbies: Cubby[];
  savedConnections: SavedConnection[];
}): PaletteGroup[] {
  const query = input.query.trim();
  const { scope, slots } = input;

  if (scope === "cubbies") {
    return group(
      "cubbies",
      "Cubbies",
      buildCubbyItems(input.cubbies, input.savedConnections, query),
    );
  }
  if (scope === "tables") {
    return group(
      "tables",
      "Tables and views",
      buildTableAndColumnItems(slots, input.activeConnectionId, query, true, false).tables,
    );
  }
  if (scope === "columns") {
    return query
      ? group(
          "columns",
          "Columns",
          buildTableAndColumnItems(slots, input.activeConnectionId, query, false, true).columns,
        )
      : [];
  }
  if (scope === "scripts") {
    return group("scripts", "Saved queries", buildScriptItems(input.savedQueries, query));
  }

  // The All tab leads with tables/columns (or recent objects, when there's no
  // query yet to scope them to) so the palette's primary job — finding a
  // table or column — surfaces before actions, tabs, and connections. Recent
  // objects come first when there are any, but the full table list always
  // follows so scrolling reliably reaches every table, not just recent ones.
  if (!query) {
    const recentItems = buildRecentObjectItems(input.recentObjects, slots);
    const recentIds = new Set(recentItems.map((item) => item.id.replace(/^recent:/, "table:")));
    const allTables = buildTableAndColumnItems(
      slots,
      input.activeConnectionId,
      query,
      true,
      false,
    ).tables.filter((item) => !recentIds.has(item.id));
    return [
      ...group("recent", "Recent database objects", recentItems),
      ...group("tables", "Tables and views", allTables),
      ...group("cubbies", "Cubbies", buildCubbyItems(input.cubbies, input.savedConnections, query)),
      ...group("actions", "Actions", buildActionItems(query)),
      ...group("tabs", "Open tabs", buildTabItems(slots, input.activeConnectionId, query)),
      ...group(
        "connections",
        "Connections",
        buildConnectionItems(slots, input.activeConnectionId, query),
      ),
    ];
  }

  const objects = buildTableAndColumnItems(slots, input.activeConnectionId, query, true, true);
  return [
    ...group("tables", "Tables and views", objects.tables),
    ...group("columns", "Columns", objects.columns),
    ...group("cubbies", "Cubbies", buildCubbyItems(input.cubbies, input.savedConnections, query)),
    ...group("actions", "Actions and settings", buildActionItems(query)),
    ...group("tabs", "Open tabs", buildTabItems(slots, input.activeConnectionId, query)),
    ...group(
      "connections",
      "Connections",
      buildConnectionItems(slots, input.activeConnectionId, query),
    ),
    ...group("scripts", "Saved queries", buildScriptItems(input.savedQueries, query)),
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
    case "whatsnew":
      return "✦";
    case "schemaCompare":
      return "⇄";
    case "erDiagram":
      return "◫";
  }
}
