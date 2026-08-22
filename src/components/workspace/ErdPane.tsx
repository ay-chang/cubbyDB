import { useEffect } from "react";

import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { QueryTab } from "../../state/store";
import { useActiveSchema, useStore } from "../../state/store";
import { buildErdGraph, layoutErdGraph, visibleColumns, type ErdNode } from "./erdGraph";

/** One table's card: header + one row per column, each row carrying its
 *  own `<Handle>` pair so an FK edge connects row-to-row rather than just
 *  box-to-box. Badges reuse `TableStructurePane`'s exact classes so a
 *  column reads the same way here as it does in "View structure". The
 *  center table (the one the diagram was opened for) gets a distinct
 *  border so it's clear at a glance which card is the subject.
 *
 *  Starts collapsed to just the PK/FK columns (`visibleColumns`) — a table
 *  with dozens of columns opening fully expanded, for every card in the
 *  neighborhood at once, is what made the diagram unreadable for anything
 *  but a small table. The "+N more" footer expands this one card only;
 *  toggling doesn't re-run layout, so it never discards a manual drag. */
function ErdTableNode({ id, data }: NodeProps<ErdNode>) {
  const { table, isCenter, expanded } = data;
  const { updateNodeData } = useReactFlow<ErdNode>();
  // An expanded card scrolls internally (see `.erd-node__rows`'s max-height)
  // rather than growing without bound — React Flow only re-measures a
  // handle's position on resize/drag by default, so scrolling needs an
  // explicit nudge or a connected edge would visually freeze mid-scroll.
  const updateNodeInternals = useUpdateNodeInternals();
  const collapsedColumns = visibleColumns(table);
  const shown = expanded ? table.columns : collapsedColumns;
  const hiddenCount = table.columns.length - collapsedColumns.length;

  return (
    <div className={`erd-node${isCenter ? " erd-node--center" : ""}`}>
      <div className="erd-node__header mono">{table.name}</div>
      <div className="erd-node__rows" onScroll={() => updateNodeInternals(id)}>
        {shown.map((col) => {
          const handleId = `${table.name}.${col.name}`;
          const isFk = col.references.length > 0;
          return (
            <div key={col.name} className="erd-node__row">
              <Handle type="target" position={Position.Left} id={handleId} className="erd-node__handle" />
              <span className="erd-node__badges">
                {col.isPrimaryKey && <span className="structure-badge structure-badge--pk">PK</span>}
                {isFk && <span className="structure-badge structure-badge--fk">FK</span>}
              </span>
              <span className="erd-node__col-name mono">{col.name}</span>
              <span className="erd-node__col-type mono">{col.dataType}</span>
              <Handle type="source" position={Position.Right} id={handleId} className="erd-node__handle" />
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="erd-node__toggle"
          onClick={() => updateNodeData(id, (node) => ({ expanded: !node.data.expanded }))}
        >
          {expanded ? "Show fewer columns" : `+${hiddenCount} more column${hiddenCount === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

const NODE_TYPES = { erdTable: ErdTableNode };

/**
 * Read-only ER diagram centered on one table: that table plus its directly
 * connected tables (one hop via foreign keys), not the whole schema — this
 * is what keeps the diagram small and fast no matter how large the schema
 * is, rather than relying only on rendering tricks. `onlyRenderVisibleElements`
 * is still set on `<ReactFlow>` below as a cheap second line of defense for
 * a table with an unusually large fan-in/out.
 *
 * Built entirely from schema data already in the store (`useActiveSchema`);
 * no fetch of its own. Layout is a one-shot `dagre` pass on load and on
 * "Re-layout" — after that, moving a node is plain React Flow drag
 * behavior, not anything this component computes. Double-clicking a
 * connected table opens (or focuses) *its* diagram tab, so exploring a
 * large schema means hopping from one small neighborhood to the next
 * rather than ever rendering everything at once.
 */
export function ErdPane({ tab }: { tab: QueryTab }) {
  const erd = tab.erd;
  const schemas = useActiveSchema();
  const schema = erd ? schemas.find((s) => s.name === erd.schema) : undefined;
  const openErDiagram = useStore((s) => s.openErDiagram);

  const centerExists =
    !!schema && !!erd && schema.tables.some((t) => t.name === erd.table && t.kind === "table");
  const graph = schema && erd && centerExists ? buildErdGraph(schema, erd.table) : null;

  const [nodes, setNodes, onNodesChange] = useNodesState<ErdNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!schema || !erd || !centerExists) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const g = buildErdGraph(schema, erd.table);
    setNodes(layoutErdGraph(g.nodes, g.edges));
    setEdges(g.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, erd?.schema, erd?.table, centerExists, setNodes, setEdges]);

  const handleNodeDoubleClick: NodeMouseHandler<ErdNode> = (_event, node) => {
    if (erd) void openErDiagram(erd.schema, node.id);
  };

  if (!erd) return null;

  return (
    <div className="erd">
      <div className="erd__topbar">
        <span className="erd__crumb mono">
          {erd.schema}.{erd.table}
        </span>
        {!!graph && graph.crossSchemaRefCount > 0 && (
          <span className="erd__note">
            {graph.crossSchemaRefCount} reference{graph.crossSchemaRefCount === 1 ? "" : "s"} to
            other schemas not shown
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost erd__relayout"
          onClick={() => setNodes((current) => layoutErdGraph(current, edges))}
        >
          Re-layout
        </button>
      </div>
      <div className="erd__canvas">
        {!schema ? (
          <div className="structure__note">Schema &quot;{erd.schema}&quot; is no longer present.</div>
        ) : !centerExists ? (
          <div className="structure__note">
            Table &quot;{erd.table}&quot; is no longer present in this schema.
          </div>
        ) : nodes.length === 0 ? (
          <div className="structure__note">
            &quot;{erd.table}&quot; has no foreign-key connections to other tables.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDoubleClick={handleNodeDoubleClick}
            nodeTypes={NODE_TYPES}
            onlyRenderVisibleElements
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
