import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";

import type { ColumnNode, SchemaNode, TableNode } from "../../types";

export interface ErdNodeData extends Record<string, unknown> {
  table: TableNode;
  /** Whether this is the table the diagram is centered on — `ErdTableNode`
   *  gives it a distinct border so it's clear at a glance which table is
   *  the subject and which are its connections. */
  isCenter: boolean;
  /** Whether this card shows every column or just the relationship-
   *  relevant ones (see `visibleColumns`). Starts `false` — a table with
   *  dozens of columns opening fully expanded is what made the first
   *  version of this diagram unreadable for anything but a small table.
   *  Toggled per-card by `ErdTableNode` itself (`updateNodeData`), not by
   *  this module — this is UI state, not part of the graph's own data. */
  expanded: boolean;
}

/**
 * The columns worth showing before a card is expanded: primary keys and
 * anything participating in an FK relationship (either direction) — which
 * is also, not coincidentally, every column an edge can actually be
 * anchored to (see `buildErdGraph`), so collapsing never hides an edge's
 * endpoint. Falls back to the first few columns for the rare table with
 * neither (e.g. a pure log/junction table with no declared PK), so a card
 * is never left with an empty body.
 */
export function visibleColumns(table: TableNode): ColumnNode[] {
  const relevant = table.columns.filter(
    (c) => c.isPrimaryKey || c.references.length > 0 || c.referencedBy.length > 0,
  );
  return relevant.length > 0 ? relevant : table.columns.slice(0, 3);
}

export type ErdNode = Node<ErdNodeData, "erdTable">;

export interface ErdGraph {
  nodes: ErdNode[];
  edges: Edge[];
  /** The center table's own FK columns (either direction) whose target
   *  lives in a different schema — not drawn (there's no data for tables
   *  outside the one schema already loaded), just counted so nothing is
   *  silently missing without a trace. */
  crossSchemaRefCount: number;
}

/**
 * Builds the node/edge graph for one table's ER neighborhood — pure data
 * transformation, no rendering or layout. Deliberately scoped to
 * `centerTable` plus its *directly connected* tables (one hop via foreign
 * keys, either direction), not the whole schema: this is what keeps the
 * diagram small and fast regardless of how many tables the schema has,
 * rather than relying only on rendering-side optimizations. Ordinary base
 * tables only (no views), same scope cut as Schema Compare. Every column
 * with an FK reference becomes one edge, anchored to that column's own
 * handle (see `ErdPane.tsx`'s `ErdTableNode`) rather than just the table
 * box as a whole, so the diagram reads as real column-to-column
 * relationships. Edges are drawn between *any* two tables in the resulting
 * neighborhood, not just ones touching the center, so a relationship
 * between two of the center's neighbors also shows up.
 */
export function buildErdGraph(schema: SchemaNode, centerTable: string): ErdGraph {
  const allTables = schema.tables.filter((t) => t.kind === "table");
  const center = allTables.find((t) => t.name === centerTable);
  if (!center) return { nodes: [], edges: [], crossSchemaRefCount: 0 };

  const neighborNames = new Set<string>();
  let crossSchemaRefCount = 0;
  for (const column of center.columns) {
    for (const ref of [...column.references, ...column.referencedBy]) {
      if (ref.schema !== schema.name) {
        crossSchemaRefCount += 1;
      } else {
        neighborNames.add(ref.table);
      }
    }
  }

  const visibleNames = new Set([centerTable, ...neighborNames]);
  const tables = allTables.filter((t) => visibleNames.has(t.name));
  const tableNames = new Set(tables.map((t) => t.name));

  const nodes: ErdNode[] = tables.map((table) => ({
    id: table.name,
    type: "erdTable",
    position: { x: 0, y: 0 },
    data: { table, isCenter: table.name === centerTable, expanded: false },
  }));

  const edges: Edge[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      for (const ref of column.references) {
        // Only the center table's own out-of-neighborhood references are
        // counted above; a neighbor's references to something entirely
        // outside this view (cross-schema or otherwise) aren't this
        // diagram's concern and are silently skipped, not counted.
        if (ref.schema !== schema.name) continue;
        if (!tableNames.has(ref.table)) continue;

        edges.push({
          id: `${table.name}.${column.name}->${ref.table}.${ref.column}`,
          source: table.name,
          sourceHandle: `${table.name}.${column.name}`,
          target: ref.table,
          targetHandle: `${ref.table}.${ref.column}`,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
        });
      }
    }
  }

  return { nodes, edges, crossSchemaRefCount };
}

const NODE_WIDTH = 260;
const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 22;
const FOOTER_HEIGHT = 22;
/** Matches `.erd-node__rows`'s CSS `max-height` — past this many rows the
 *  card scrolls internally rather than growing without bound, so a table
 *  with e.g. 70 columns expanded doesn't reserve a giant, mostly-empty
 *  column of canvas space that pushes every other card far away. */
const MAX_VISIBLE_ROWS = 14;

function estimatedNodeHeight(node: ErdNode): number {
  const total = node.data.table.columns.length;
  const shown = node.data.expanded ? total : visibleColumns(node.data.table).length;
  const rows = Math.min(shown, MAX_VISIBLE_ROWS);
  const footer = shown < total ? FOOTER_HEIGHT : 0;
  return HEADER_HEIGHT + rows * ROW_HEIGHT + footer;
}

/**
 * Computes initial `x`/`y` for every node via `@dagrejs/dagre` — a one-shot
 * layout pass, not a live physics simulation. After this runs, dragging a
 * node is entirely React Flow's own built-in behavior; this function is
 * only called again when the schema changes or the user hits "Re-layout"
 * (expanding/collapsing a single card does *not* trigger this — it just
 * resizes that one card in place, so a careful manual arrangement isn't
 * discarded by opening one table's full column list).
 */
export function layoutErdGraph(nodes: ErdNode[], edges: Edge[]): ErdNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: estimatedNodeHeight(node) });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const height = estimatedNodeHeight(node);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - height / 2 },
    };
  });
}
