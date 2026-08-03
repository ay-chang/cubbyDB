import { useEffect, useMemo, useRef, useState } from "react";

import { formatCount } from "../../lib/format";
import type { FuzzyMatch } from "../../lib/fuzzyMatch";
import { bestMatch } from "../../lib/fuzzyMatch";
import { useStore } from "../../state/store";
import type { SavedQuery, TableKind } from "../../types";

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
    }
  | {
      id: string;
      kind: "script";
      query: SavedQuery;
      match: FuzzyMatch & { candidate: number };
    };

const MAX_RESULTS = 40;
const NO_MATCH: FuzzyMatch & { candidate: number } = { score: 0, indices: [], candidate: -1 };

/** A single-line, length-capped preview of a saved script's SQL for the
 *  palette row's meta column — full text lives in the Saved Queries panel. */
function scriptPreview(sql: string): string {
  const line = sql.trim().replace(/\s+/g, " ");
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

/**
 * Which kinds of thing the palette is searching. "All" is the default —
 * tables, columns (once you've typed something), and saved scripts (same
 * condition) all mixed together — and the narrower scopes exist for when you
 * know what you're after and the mixed list gets in the way — searching a
 * wide schema for "id" otherwise buries every table under a hundred `id`
 * columns. "Scripts" searches saved queries instead — those are global (not
 * tied to any one connection, see `SavedQuery`), so this scope (and its
 * contribution to "All") shows the exact same list no matter which database
 * is active. Tab cycles forward, Shift+Tab back, wrapping both ways so Tab
 * alone reaches all four.
 */
type Scope = "all" | "tables" | "columns" | "scripts";
const SCOPES: Array<{ id: Scope; label: string; placeholder: string }> = [
  { id: "all", label: "All", placeholder: "Search tables and columns…" },
  { id: "tables", label: "Tables", placeholder: "Search tables…" },
  { id: "columns", label: "Columns", placeholder: "Search columns…" },
  { id: "scripts", label: "Scripts", placeholder: "Search saved scripts…" },
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
 * definition." The Scripts scope searches saved queries instead: since those
 * are global rather than per-connection, the same list shows up no matter
 * which database is active, and Enter opens the script as a tab on whichever
 * connection is currently active (see `openSavedQuery`).
 */
export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const close = useStore((s) => s.closeCommandPalette);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const switchConnection = useStore((s) => s.switchConnection);
  const openSelectTop = useStore((s) => s.openSelectTop);
  const jumpToColumn = useStore((s) => s.jumpToColumn);
  const savedQueries = useStore((s) => s.savedQueries);
  const openSavedQuery = useStore((s) => s.openSavedQuery);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The browser fires `mouseenter` on whatever list item ends up under an
  // already-stationary cursor the instant it appears — on open, and again
  // whenever the list reflows under a typed query — which would otherwise
  // silently steal the keyboard-driven selection away from row 0. Hover only
  // starts choosing a row once the mouse has demonstrably moved since the
  // list last reset, tracked here rather than in state since it never needs
  // to trigger a render on its own.
  const mouseArmedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setSelected(0);
    mouseArmedRef.current = false;
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

  /** Score every saved script against `q` (or, with `q` empty, every script
   *  at score 0 — `bestMatch` already treats an empty query as a match-all).
   *  Shared by the dedicated Scripts scope and, when there's something
   *  typed, folded into the All scope below. */
  const matchScripts = (q: string): Array<{ item: Item; score: number }> => {
    const scored: Array<{ item: Item; score: number }> = [];
    for (const sq of savedQueries) {
      const m = bestMatch(q, [sq.name]);
      if (!m) continue;
      scored.push({
        item: { id: `s:${sq.id}`, kind: "script", query: sq, match: m },
        score: m.score,
      });
    }
    return scored;
  };

  const results = useMemo(() => {
    const q = query.trim();

    // Scripts are global — one list, the same regardless of which
    // connection is active — so this scope skips the per-connection loop
    // below entirely and searches `savedQueries` directly.
    if (scope === "scripts") {
      const scored = matchScripts(q);
      if (q) scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_RESULTS).map((x) => x.item);
    }

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
    // Fold in saved scripts too, same as tables/columns above — but only
    // once there's something typed, so the default "All" view (no query)
    // still shows just tables, same as it always has.
    if (scope === "all" && q) {
      scored.push(...matchScripts(q));
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
  }, [slots, query, scope, savedQueries]);

  useEffect(() => {
    setSelected(0);
    // The result list just reordered — same reasoning as the `open` reset
    // above, so the same guard against a stationary mouse applies again.
    mouseArmedRef.current = false;
  }, [query, scope]);

  const activate = (item: Item) => {
    if (item.kind === "script") {
      void openSavedQuery(item.query);
      close();
      return;
    }
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
        aria-label="Search tables, columns, and saved scripts"
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
        <div className="cmdk-list" onMouseMove={() => { mouseArmedRef.current = true; }}>
          {results.length === 0 ? (
            <div className="cmdk-empty">
              {query.trim()
                ? "No matches."
                : scope === "columns"
                  ? "Type to search columns."
                  : scope === "scripts"
                    ? "No saved scripts yet."
                    : "No tables."}
            </div>
          ) : (
            results.map((item, i) => (
              <div
                key={item.id}
                className={"cmdk-item" + (i === selected ? " cmdk-item--active" : "")}
                onMouseEnter={() => {
                  if (mouseArmedRef.current) setSelected(i);
                }}
                onClick={() => activate(item)}
              >
                <span className="cmdk-item__icon">
                  {item.kind === "table"
                    ? item.tableKind === "view"
                      ? "▨"
                      : "▦"
                    : item.kind === "column"
                      ? "·"
                      : "▤"}
                </span>
                {item.kind !== "script" && showConnBadge && (
                  <span className="cmdk-item__conn">{item.connectionName}</span>
                )}
                <span className="cmdk-item__label">
                  {item.kind === "table" ? (
                    <>
                      <span className="cmdk-item__path">{item.schema}.</span>
                      {highlight(item.table, item.match.candidate === 0 ? item.match.indices : [])}
                    </>
                  ) : item.kind === "column" ? (
                    <>
                      <span className="cmdk-item__path">
                        {item.schema}.{item.table}.
                      </span>
                      {highlight(
                        item.column,
                        item.match.candidate === 0 ? item.match.indices : [],
                      )}
                    </>
                  ) : (
                    highlight(item.query.name, item.match.candidate === 0 ? item.match.indices : [])
                  )}
                </span>
                <span
                  className={
                    "cmdk-item__meta mono" +
                    (item.kind === "script" ? " cmdk-item__meta--script" : "")
                  }
                >
                  {item.kind === "table"
                    ? formatCount(item.estimatedRows)
                    : item.kind === "column"
                      ? item.dataType
                      : scriptPreview(item.query.sql)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
