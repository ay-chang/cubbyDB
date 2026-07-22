import { useEffect, useMemo, useState } from "react";

import {
  useActiveSchema,
  useActiveSchemaError,
  useActiveSchemaLoading,
  useStore,
} from "../../state/store";
import type { SchemaNode, TableNode } from "../../types";

/** Compact row-count label: 1.2M, 88k, 3.4k, ... */
function formatCount(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

interface Menu {
  x: number;
  y: number;
  schema: string;
  table: string;
}

export function SchemaTree() {
  const schema = useActiveSchema();
  const loading = useActiveSchemaLoading();
  const error = useActiveSchemaError();
  const openSelectTop = useStore((s) => s.openSelectTop);
  const openTableStructure = useStore((s) => s.openTableStructure);

  const [filter, setFilter] = useState("");
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

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

  function toggleSchema(name: string) {
    setExpandedSchemas((prev) => toggle(prev, name));
  }
  function toggleTable(key: string) {
    setExpandedTables((prev) => toggle(prev, key));
  }

  return (
    <div className="tree">
      <div className="tree__filter">
        <input
          className="tree__filter-input"
          placeholder="Filter schema…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="tree__scroll">
        {loading && schema.length === 0 && (
          <div className="tree__note">Loading schema…</div>
        )}
        {error && <div className="tree__note tree__note--error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="tree__note">No matching objects.</div>
        )}

        {filtered.map((s) => {
          const schemaOpen = expandedSchemas.has(s.name) || filter.trim() !== "";
          return (
            <div key={s.name}>
              <div
                className="tree__row tree__row--schema"
                onClick={() => toggleSchema(s.name)}
              >
                <span className="tree__chevron">{schemaOpen ? "▼" : "▶"}</span>
                <span className="tree__icon">▤</span>
                <span className="tree__label">{s.name}</span>
              </div>

              {schemaOpen && (
                <div className="tree__children">
                  {s.tables.map((t) => {
                    const key = `${s.name}.${t.name}`;
                    const tableOpen =
                      expandedTables.has(key) || filter.trim() !== "";
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
                          <span className="tree__icon">
                            {t.kind === "view" ? "▨" : "▦"}
                          </span>
                          <span className="tree__label">{t.name}</span>
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
            </div>
          );
        })}
      </div>

      {menu && (
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
        </div>
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

/** Filter tables/schemas by name substring; keeps schemas with any match. */
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
    if (tables.length > 0) out.push({ ...s, tables });
  }
  return out;
}
