import { useEffect, useMemo, useRef, useState } from "react";

import { formatCount } from "../../lib/format";
import type { FuzzyMatch } from "../../lib/fuzzyMatch";
import { bestMatch } from "../../lib/fuzzyMatch";
import { useStore } from "../../state/store";
import type { TableKind } from "../../types";

type Item =
  | {
      id: string;
      kind: "table";
      sessionId: string;
      connectionName: string;
      schema: string;
      table: string;
      tableKind: TableKind;
      estimatedRows: number | null;
      match: FuzzyMatch & { candidate: number };
    }
  | {
      id: string;
      kind: "column";
      sessionId: string;
      connectionName: string;
      schema: string;
      table: string;
      column: string;
      dataType: string;
      match: FuzzyMatch & { candidate: number };
    };

const MAX_RESULTS = 40;
const NO_MATCH: FuzzyMatch & { candidate: number } = { score: 0, indices: [], candidate: -1 };

/**
 * Which kinds of thing the palette is searching. "All" is the default and
 * behaves exactly as the palette always has; the narrower scopes exist for
 * when you know what you're after and the mixed list gets in the way —
 * searching a wide schema for "id" otherwise buries every table under a
 * hundred `id` columns. Tab cycles forward, Shift+Tab back, wrapping both
 * ways so Tab alone reaches all three.
 */
type Scope = "all" | "tables" | "columns";
const SCOPES: Array<{ id: Scope; label: string; placeholder: string }> = [
  { id: "all", label: "All", placeholder: "Search tables and columns…" },
  { id: "tables", label: "Tables", placeholder: "Search tables…" },
  { id: "columns", label: "Columns", placeholder: "Search columns…" },
];

/** Render `text` with the characters at `indices` wrapped in <mark>. */
function highlight(text: string, indices: number[]): React.ReactNode {
  if (indices.length === 0) return text;
  const idxSet = new Set(indices);
  const parts: React.ReactNode[] = [];
  let buffer = "";
  let inMatch = false;
  let key = 0;
  for (let i = 0; i < text.length; i++) {
    const isMatch = idxSet.has(i);
    if (isMatch !== inMatch && buffer) {
      parts.push(inMatch ? <mark key={key++}>{buffer}</mark> : buffer);
      buffer = "";
    }
    buffer += text[i];
    inMatch = isMatch;
  }
  if (buffer) parts.push(inMatch ? <mark key={key++}>{buffer}</mark> : buffer);
  return parts;
}

/**
 * Cmd/Ctrl+K quick-jump: fuzzy-search every table and column across *every
 * open connection*, not just the visible one — so searching while staging
 * and prod are both connected finds tables/columns in either. Each result
 * is tagged with which connection it's from (shown as a badge once more
 * than one connection is open); jumping to a result on a different
 * connection switches to it first. Enter on a table opens/focuses its
 * browse-rows tab (same as clicking it in the sidebar); Enter on a column
 * opens/focuses that table's structure tab and scrolls to + briefly
 * highlights that column's row there — there's no "column" surface to jump
 * to directly, so this is the closest thing to "go to this column's
 * definition."
 */
export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const close = useStore((s) => s.closeCommandPalette);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const switchConnection = useStore((s) => s.switchConnection);
  const openSelectTop = useStore((s) => s.openSelectTop);
  const jumpToColumn = useStore((s) => s.jumpToColumn);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  /** Move `delta` scopes along the strip, wrapping at both ends. */
  const cycleScope = (delta: number) => {
    setScope((prev) => {
      const i = SCOPES.findIndex((s) => s.id === prev);
      return SCOPES[(i + delta + SCOPES.length) % SCOPES.length].id;
    });
  };

  const slots = useMemo(() => Object.values(connections), [connections]);
  const showConnBadge = slots.length > 1;

  const results = useMemo(() => {
    const q = query.trim();
    const wantTables = scope === "all" || scope === "tables";
    const wantColumns = scope === "all" || scope === "columns";
    const scored: Array<{ item: Item; score: number }> = [];
    for (const slot of slots) {
      const sessionId = slot.sessionId;
      const connectionName = slot.current.name;
      for (const s of slot.schema) {
        for (const t of s.tables) {
          if (wantTables && q) {
            const m = bestMatch(q, [t.name, `${s.name}.${t.name}`]);
            if (m) {
              scored.push({
                item: {
                  id: `t:${sessionId}:${s.name}.${t.name}`,
                  kind: "table",
                  sessionId,
                  connectionName,
                  schema: s.name,
                  table: t.name,
                  tableKind: t.kind,
                  estimatedRows: t.estimatedRows,
                  match: m,
                },
                score: m.score,
              });
            }
          } else if (wantTables) {
            scored.push({
              item: {
                id: `t:${sessionId}:${s.name}.${t.name}`,
                kind: "table",
                sessionId,
                connectionName,
                schema: s.name,
                table: t.name,
                tableKind: t.kind,
                estimatedRows: t.estimatedRows,
                match: NO_MATCH,
              },
              score: 0,
            });
          }
          // Skip columns entirely when the box is empty — dumping every
          // column from every table would swamp the "browse tables" default,
          // and in the Columns scope it would be tens of thousands of entries
          // to build and sort for a list that shows 40. The empty state below
          // says to type instead.
          if (!q || !wantColumns) continue;
          for (const c of t.columns) {
            const m = bestMatch(q, [c.name, `${t.name}.${c.name}`]);
            if (m) {
              scored.push({
                item: {
                  id: `c:${sessionId}:${s.name}.${t.name}.${c.name}`,
                  kind: "column",
                  sessionId,
                  connectionName,
                  schema: s.name,
                  table: t.name,
                  column: c.name,
                  dataType: c.dataType,
                  match: m,
                },
                score: m.score,
              });
            }
          }
        }
      }
    }
    if (q) {
      scored.sort((a, b) => b.score - a.score);
    } else {
      // Group by connection, then alphabetically within it.
      scored.sort((a, b) => {
        const a2 = a.item as Extract<Item, { kind: "table" }>;
        const b2 = b.item as Extract<Item, { kind: "table" }>;
        return (
          a2.connectionName.localeCompare(b2.connectionName) ||
          `${a2.schema}.${a2.table}`.localeCompare(`${b2.schema}.${b2.table}`)
        );
      });
    }
    return scored.slice(0, MAX_RESULTS).map((x) => x.item);
  }, [slots, query, scope]);

  useEffect(() => {
    setSelected(0);
  }, [query, scope]);

  const activate = (item: Item) => {
    if (item.sessionId !== activeConnectionId) switchConnection(item.sessionId);
    if (item.kind === "table") {
      void openSelectTop(item.schema, item.table);
    } else {
      void jumpToColumn(item.schema, item.table, item.column);
    }
    close();
  };

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={close}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search tables and columns"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={SCOPES.find((s) => s.id === scope)!.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              // Focus stays in the box — there's nothing else in the palette
              // worth tabbing to, and typing has to keep working mid-cycle.
              e.preventDefault();
              e.stopPropagation();
              cycleScope(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              setSelected((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              setSelected((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              const item = results[selected];
              if (item) activate(item);
            }
          }}
        />
        <div className="cmdk-scopes" role="tablist" aria-label="Search scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === scope}
              className={"cmdk-scope" + (s.id === scope ? " cmdk-scope--active" : "")}
              onClick={() => {
                setScope(s.id);
                inputRef.current?.focus();
              }}
            >
              {s.label}
            </button>
          ))}
          <span className="cmdk-scopes__hint mono">⇥ / ⇧⇥</span>
        </div>
        <div className="cmdk-list">
          {results.length === 0 ? (
            <div className="cmdk-empty">
              {query.trim()
                ? "No matches."
                : scope === "columns"
                  ? "Type to search columns."
                  : "No tables."}
            </div>
          ) : (
            results.map((item, i) => (
              <div
                key={item.id}
                className={"cmdk-item" + (i === selected ? " cmdk-item--active" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => activate(item)}
              >
                <span className="cmdk-item__icon">
                  {item.kind === "table" ? (item.tableKind === "view" ? "▨" : "▦") : "·"}
                </span>
                {showConnBadge && (
                  <span className="cmdk-item__conn">{item.connectionName}</span>
                )}
                <span className="cmdk-item__label">
                  {item.kind === "table" ? (
                    <>
                      <span className="cmdk-item__path">{item.schema}.</span>
                      {highlight(item.table, item.match.candidate === 0 ? item.match.indices : [])}
                    </>
                  ) : (
                    <>
                      <span className="cmdk-item__path">
                        {item.schema}.{item.table}.
                      </span>
                      {highlight(
                        item.column,
                        item.match.candidate === 0 ? item.match.indices : [],
                      )}
                    </>
                  )}
                </span>
                <span className="cmdk-item__meta mono">
                  {item.kind === "table" ? formatCount(item.estimatedRows) : item.dataType}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
