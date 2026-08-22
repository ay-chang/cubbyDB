import { useEffect, useMemo, useState } from "react";

import { formatCount } from "../../lib/format";
import { formatBinding, formatShortcutTitle, useKeybindingStore } from "../../lib/keybindings";
import {
  cubbyTableRefs,
  useActiveCubby,
  useActiveSchema,
  useActiveSchemaError,
  useActiveSchemaLoading,
  useStore,
} from "../../state/store";
import type { SchemaNode, TableNode } from "../../types";
import { SchemaComparePicker } from "./SchemaComparePicker";

type Menu =
  | { kind: "table"; x: number; y: number; schema: string; table: string }
  | { kind: "function"; x: number; y: number; schema: string; oid: number; name: string }
  | { kind: "sequence"; x: number; y: number; schema: string; name: string }
  | { kind: "schema"; x: number; y: number; schema: string };

export function SchemaTree({ onClose }: { onClose: () => void }) {
  const schema = useActiveSchema();
  const loading = useActiveSchemaLoading();
  const error = useActiveSchemaError();
  const openSelectTop = useStore((s) => s.openSelectTop);
  const openTableStructure = useStore((s) => s.openTableStructure);
  const openFunctionDefinition = useStore((s) => s.openFunctionDefinition);
  const openSequenceDetails = useStore((s) => s.openSequenceDetails);
  const openErDiagram = useStore((s) => s.openErDiagram);
  const toggleCommandPalette = useStore((s) => s.toggleCommandPalette);
  const activeCubby = useActiveCubby();
  const addEntryToCubby = useStore((s) => s.addEntryToCubby);
  const removeTableFromCubby = useStore((s) => s.removeTableFromCubby);
  const commandPaletteBinding = useKeybindingStore(
    (s) => s.bindings["workspace.commandPalette"],
  );
  const sidebarBinding = useKeybindingStore(
    (s) => s.bindings["workspace.toggleSidebar"],
  );

  const [filter, setFilter] = useState("");
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  // Tables, unlike the groups below, starts open by default (it's the
  // primary, most-used content) — so this tracks which schemas' Tables
  // group has been *collapsed*, the inverse of `expandedGroups`.
  const [collapsedTableGroups, setCollapsedTableGroups] = useState<Set<string>>(new Set());
  // Functions/Sequences/Types group headers, default collapsed — keeps the
  // existing Tables UX untouched and avoids clutter for schemas with many
  // extension-installed functions.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [comparePicker, setComparePicker] = useState<{ schema: string } | null>(null);
  const activeConnectionId = useStore((s) => s.activeConnectionId);

  // Expand the first schema by default once the tree loads.
  useEffect(() => {
    if (schema.length > 0 && expandedSchemas.size === 0) {
      setExpandedSchemas(new Set([schema[0].name]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const filtered = useMemo(
    () => filterTree(schema, filter.trim().toLowerCase()),
    [schema, filter],
  );
  const filtering = filter.trim() !== "";

  // The active cubby's tables, pinned above the normal tree — additive, not
  // a replacement: the full schema below is always still there, and the
  // text filter above searches all of it regardless of what's pinned.
  const pinnedTables = useMemo(
    () => (activeCubby ? cubbyTableRefs(activeCubby) : []),
    [activeCubby],
  );
  const pinnedMultiSchema = useMemo(
    () => new Set(pinnedTables.map((t) => t.schema)).size > 1,
    [pinnedTables],
  );

  function toggleSchema(name: string) {
    setExpandedSchemas((prev) => toggle(prev, name));
  }
  function toggleTable(key: string) {
    setExpandedTables((prev) => toggle(prev, key));
  }
  function toggleTablesGroup(key: string) {
    setCollapsedTableGroups((prev) => toggle(prev, key));
  }
  function toggleGroup(key: string) {
    setExpandedGroups((prev) => toggle(prev, key));
  }
  function toggleType(key: string) {
    setExpandedTypes((prev) => toggle(prev, key));
  }

  return (
    <div className="tree">
      <div className="tree__filter">
        <div className="tree__filter-input-wrap">
          <input
            className={
              "tree__filter-input" +
              (commandPaletteBinding ? " tree__filter-input--shortcut" : "")
            }
            placeholder="Filter schema…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
          {commandPaletteBinding && (
            <button
              className="tree__filter-shortcut mono"
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleCommandPalette}
              title="Search CubbyDB"
              aria-label={`Open command palette (${formatBinding(commandPaletteBinding)})`}
            >
              {formatBinding(commandPaletteBinding)}
            </button>
          )}
        </div>
        <button
          className="tree__collapse"
          onClick={onClose}
          title={formatShortcutTitle("Hide schema sidebar", sidebarBinding)}
          aria-label="Hide schema sidebar"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="10" y1="4" x2="10" y2="20" />
            <path d="M7 10l-2 2 2 2" />
          </svg>
        </button>
      </div>

      <div className="tree__scroll">
        {loading && schema.length === 0 && (
          <div className="tree__note">Loading schema…</div>
        )}
        {error && <div className="tree__note tree__note--error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="tree__note">No matching objects.</div>
        )}

        {!filtering && activeCubby && pinnedTables.length > 0 && (
          <div className="tree__pinned">
            <div
              className="tree__row tree__row--cubby"
              onClick={() => setPinnedCollapsed((v) => !v)}
            >
              <span className="tree__chevron">{pinnedCollapsed ? "▶" : "▼"}</span>
              <span className="tree__label">{activeCubby.name}</span>
              <span className="tree__count mono">{pinnedTables.length}</span>
            </div>
            {!pinnedCollapsed && (
              <div className="tree__children">
                {pinnedTables.map((ref) => {
                  const key = `pinned:${ref.schema}.${ref.table}`;
                  return (
                    <div
                      key={key}
                      className="tree__row tree__row--table tree__row--pinned"
                      title={`${ref.schema}.${ref.table}`}
                      onClick={() => {
                        setSelected(key);
                        void openSelectTop(ref.schema, ref.table);
                      }}
                    >
                      <span className="tree__chevron" />
                      <span className="tree__label">
                        {/* The schema is normally implied by the tree's own
                            nesting, which a flat pinned list loses — so show
                            it only when the pinned tables actually span more
                            than one schema and the bare name is ambiguous. */}
                        {pinnedMultiSchema && (
                          <span className="tree__path">{ref.schema}.</span>
                        )}
                        {ref.table}
                      </span>
                      <span
                        className="tree__pin-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeTableFromCubby(activeCubby.id, ref.schema, ref.table);
                        }}
                        title={`Remove from ${activeCubby.name}`}
                      >
                        ×
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {filtered.map((s) => {
          const schemaOpen = expandedSchemas.has(s.name) || filtering;
          const tablesKey = `${s.name}:tables`;
          const functionsKey = `${s.name}:functions`;
          const sequencesKey = `${s.name}:sequences`;
          const typesKey = `${s.name}:types`;
          // Tables starts open (it's the primary, most-used content), unlike
          // Functions/Sequences/Types below — so it's tracked as a
          // *collapsed* set instead, where absence means open.
          const tablesOpen = !collapsedTableGroups.has(tablesKey) || filtering;
          const functionsOpen = expandedGroups.has(functionsKey) || filtering;
          const sequencesOpen = expandedGroups.has(sequencesKey) || filtering;
          const typesOpen = expandedGroups.has(typesKey) || filtering;

          return (
            <div key={s.name}>
              <div
                className="tree__row tree__row--schema"
                onClick={() => toggleSchema(s.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: "schema", x: e.clientX, y: e.clientY, schema: s.name });
                }}
              >
                <span className="tree__chevron">{schemaOpen ? "▼" : "▶"}</span>
                <span className="tree__icon">▤</span>
                <span className="tree__label">{s.name}</span>
              </div>

              {schemaOpen && (
                <div className="tree__children">
                  <div
                    className="tree__row tree__row--group"
                    onClick={() => toggleTablesGroup(tablesKey)}
                  >
                    <span className="tree__chevron">{tablesOpen ? "▼" : "▶"}</span>
                    <span className="tree__icon" aria-hidden />
                    <span className="tree__label">Tables</span>
                    <span className="tree__count mono">{s.tables.length}</span>
                  </div>
                  {tablesOpen && (
                    <div className="tree__children">
                      {s.tables.map((t) => {
                        const key = `${s.name}.${t.name}`;
                        const tableOpen = expandedTables.has(key) || filtering;
                        const isSelected = selected === key;
                        return (
                          <div key={key}>
                            <div
                              className={
                                "tree__row tree__row--table" +
                                (isSelected ? " tree__row--selected" : "")
                              }
                              onClick={() => {
                                setSelected(key);
                                // Clicking a table opens its rows directly.
                                void openSelectTop(s.name, t.name);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setSelected(key);
                                setMenu({
                                  kind: "table",
                                  x: e.clientX,
                                  y: e.clientY,
                                  schema: s.name,
                                  table: t.name,
                                });
                              }}
                            >
                              <span
                                className="tree__chevron tree__chevron--btn"
                                title={tableOpen ? "Hide columns" : "Show columns"}
                                onClick={(e) => {
                                  // The chevron is the only way to peek at columns;
                                  // it must not also open the table.
                                  e.stopPropagation();
                                  toggleTable(key);
                                }}
                              >
                                {tableOpen ? "▼" : "▶"}
                              </span>
                              <span className="tree__label">
                                {t.name}
                                {t.kind === "view" && (
                                  <span className="tree__view-tag">view</span>
                                )}
                              </span>
                              {t.estimatedRows != null && (
                                <span className="tree__count mono">
                                  {formatCount(t.estimatedRows)}
                                </span>
                              )}
                            </div>

                            {tableOpen && (
                              <div className="tree__columns">
                                {t.columns.map((c) => (
                                  <div key={c.name} className="tree__col">
                                    <span className="tree__col-name">{c.name}</span>
                                    {c.isPrimaryKey && (
                                      <span className="tree__pk" title="Primary key">
                                        pk
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {s.tables.length === 0 && (
                        <div className="tree__note tree__note--sub">No tables.</div>
                      )}
                    </div>
                  )}

                  {s.functions.length > 0 && (
                    <div>
                      <div
                        className="tree__row tree__row--group"
                        onClick={() => toggleGroup(functionsKey)}
                      >
                        <span className="tree__chevron">{functionsOpen ? "▼" : "▶"}</span>
                        <span className="tree__icon" aria-hidden />
                        <span className="tree__label">Functions</span>
                        <span className="tree__count mono">{s.functions.length}</span>
                      </div>
                      {functionsOpen && (
                        <div className="tree__children">
                          {s.functions.map((fn) => {
                            const key = `${s.name}.fn.${fn.oid}`;
                            const isSelected = selected === key;
                            return (
                              <div
                                key={key}
                                className={
                                  "tree__row tree__row--table" +
                                  (isSelected ? " tree__row--selected" : "")
                                }
                                title={`${fn.name}(${fn.arguments})${fn.returnType ? ` → ${fn.returnType}` : ""}`}
                                onClick={() => {
                                  setSelected(key);
                                  void openFunctionDefinition(s.name, fn.oid, fn.name);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSelected(key);
                                  setMenu({
                                    kind: "function",
                                    x: e.clientX,
                                    y: e.clientY,
                                    schema: s.name,
                                    oid: fn.oid,
                                    name: fn.name,
                                  });
                                }}
                              >
                                <span className="tree__chevron" />
                                <span className="tree__icon">ƒ</span>
                                <span className="tree__label">
                                  {fn.name}({fn.arguments})
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {s.sequences.length > 0 && (
                    <div>
                      <div
                        className="tree__row tree__row--group"
                        onClick={() => toggleGroup(sequencesKey)}
                      >
                        <span className="tree__chevron">{sequencesOpen ? "▼" : "▶"}</span>
                        <span className="tree__icon" aria-hidden />
                        <span className="tree__label">Sequences</span>
                        <span className="tree__count mono">{s.sequences.length}</span>
                      </div>
                      {sequencesOpen && (
                        <div className="tree__children">
                          {s.sequences.map((seq) => {
                            const key = `${s.name}.seq.${seq.name}`;
                            const isSelected = selected === key;
                            return (
                              <div
                                key={key}
                                className={
                                  "tree__row tree__row--table" +
                                  (isSelected ? " tree__row--selected" : "")
                                }
                                title={
                                  seq.ownedBy
                                    ? `Owned by ${seq.ownedBy.table}.${seq.ownedBy.column}`
                                    : undefined
                                }
                                onClick={() => {
                                  setSelected(key);
                                  void openSequenceDetails(s.name, seq.name);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSelected(key);
                                  setMenu({
                                    kind: "sequence",
                                    x: e.clientX,
                                    y: e.clientY,
                                    schema: s.name,
                                    name: seq.name,
                                  });
                                }}
                              >
                                <span className="tree__chevron" />
                                <span className="tree__icon">#</span>
                                <span className="tree__label">{seq.name}</span>
                                {seq.ownedBy && (
                                  <span className="tree__count mono">
                                    → {seq.ownedBy.table}.{seq.ownedBy.column}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {s.types.length > 0 && (
                    <div>
                      <div
                        className="tree__row tree__row--group"
                        onClick={() => toggleGroup(typesKey)}
                      >
                        <span className="tree__chevron">{typesOpen ? "▼" : "▶"}</span>
                        <span className="tree__icon" aria-hidden />
                        <span className="tree__label">Types</span>
                        <span className="tree__count mono">{s.types.length}</span>
                      </div>
                      {typesOpen && (
                        <div className="tree__children">
                          {s.types.map((ty) => {
                            const key = `${s.name}.ty.${ty.name}`;
                            const valuesOpen = expandedTypes.has(key) || filtering;
                            return (
                              <div key={key}>
                                <div
                                  className="tree__row tree__row--table"
                                  onClick={() => toggleType(key)}
                                >
                                  <span
                                    className="tree__chevron tree__chevron--btn"
                                    title={valuesOpen ? "Hide values" : "Show values"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleType(key);
                                    }}
                                  >
                                    {valuesOpen ? "▼" : "▶"}
                                  </span>
                                  <span className="tree__icon">◇</span>
                                  <span className="tree__label">{ty.name}</span>
                                  <span className="tree__count mono">
                                    {ty.values.length}
                                  </span>
                                </div>
                                {valuesOpen && (
                                  <div className="tree__columns">
                                    {ty.values.map((v) => (
                                      <div key={v} className="tree__col">
                                        <span className="tree__col-name">{v}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {menu?.kind === "table" && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              void openSelectTop(menu.schema, menu.table);
            }}
          >
            Select top 100
          </button>
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              void openTableStructure(menu.schema, menu.table);
            }}
          >
            View structure
          </button>
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              void openErDiagram(menu.schema, menu.table);
            }}
          >
            View ER diagram
          </button>
          {activeCubby && (
            <button
              className="context-menu__item"
              onClick={() => {
                setMenu(null);
                void addEntryToCubby(activeCubby.id, {
                  kind: "table",
                  schema: menu.schema,
                  table: menu.table,
                });
              }}
            >
              Add to {activeCubby.name}
            </button>
          )}
        </div>
      )}

      {menu?.kind === "function" && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              void openFunctionDefinition(menu.schema, menu.oid, menu.name);
            }}
          >
            View definition
          </button>
          {activeCubby && (
            <button
              className="context-menu__item"
              onClick={() => {
                setMenu(null);
                void addEntryToCubby(activeCubby.id, {
                  kind: "function",
                  schema: menu.schema,
                  name: menu.name,
                  oid: menu.oid,
                });
              }}
            >
              Add to {activeCubby.name}
            </button>
          )}
        </div>
      )}

      {menu?.kind === "sequence" && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              void openSequenceDetails(menu.schema, menu.name);
            }}
          >
            View details
          </button>
          {activeCubby && (
            <button
              className="context-menu__item"
              onClick={() => {
                setMenu(null);
                void addEntryToCubby(activeCubby.id, {
                  kind: "sequence",
                  schema: menu.schema,
                  name: menu.name,
                });
              }}
            >
              Add to {activeCubby.name}
            </button>
          )}
        </div>
      )}

      {menu?.kind === "schema" && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu__item"
            onClick={() => {
              setComparePicker({ schema: menu.schema });
              setMenu(null);
            }}
          >
            Compare schema…
          </button>
        </div>
      )}

      {comparePicker && activeConnectionId && (
        <SchemaComparePicker
          sourceSessionId={activeConnectionId}
          sourceSchema={comparePicker.schema}
          onClose={() => setComparePicker(null)}
        />
      )}
    </div>
  );
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Filter tables/functions/sequences/types by name (and, for tables and
 *  enum types, by what's inside them — columns / values) substring; keeps
 *  schemas with any match. */
function filterTree(schema: SchemaNode[], q: string): SchemaNode[] {
  if (!q) return schema;
  const out: SchemaNode[] = [];
  for (const s of schema) {
    if (s.name.toLowerCase().includes(q)) {
      out.push(s);
      continue;
    }
    const tables: TableNode[] = s.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)),
    );
    const functions = s.functions.filter((f) => f.name.toLowerCase().includes(q));
    const sequences = s.sequences.filter((sq) => sq.name.toLowerCase().includes(q));
    const types = s.types.filter(
      (ty) =>
        ty.name.toLowerCase().includes(q) ||
        ty.values.some((v) => v.toLowerCase().includes(q)),
    );
    if (
      tables.length > 0 ||
      functions.length > 0 ||
      sequences.length > 0 ||
      types.length > 0
    ) {
      out.push({ ...s, tables, functions, sequences, types });
    }
  }
  return out;
}
