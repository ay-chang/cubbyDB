import { useEffect, useMemo, useState } from "react";

import type { QueryTab } from "../../state/store";
import { useStore } from "../../state/store";
import type { ForeignKeyRef, QueryResult } from "../../types";
import { FilterBar } from "./FilterBar";

/**
 * The results region beneath the editor. Renders, in order of precedence:
 *   1. an inline error strip (never a modal) when the last run failed,
 *   2. a table of rows when the query returned a result set,
 *   3. a command-tag note for non-row-returning statements,
 *   4. an idle hint before the first run.
 */
export function ResultsPane({ tab }: { tab: QueryTab }) {
  const result = tab.error ? null : tab.result;

  // Infer which columns are numeric so they can be right-aligned in mono,
  // matching the design (we don't get types back from simple_query).
  const numericCols = useMemo(
    () => (result ? inferNumericColumns(result) : []),
    [result],
  );

  // For table tabs, map each result column to its foreign keys in both
  // directions (from the schema): outgoing (this cell points at another row) and
  // incoming (other tables point at this row).
  const schema = useStore((s) => s.schema);
  const navByColumn = useMemo(() => {
    if (!result || tab.kind !== "table" || !tab.source) return null;
    const table = schema
      .find((s) => s.name === tab.source!.schema)
      ?.tables.find((t) => t.name === tab.source!.table);
    if (!table) return null;
    const byName = new Map(table.columns.map((c) => [c.name, c]));
    return result.columns.map((c) => {
      const col = byName.get(c.name);
      return {
        references: col?.references ?? [],
        referencedBy: col?.referencedBy ?? [],
      };
    });
  }, [result, schema, tab]);

  return (
    <div className="results">
      <ResultsHeader tab={tab} result={result} />

      {tab.error ? (
        <ErrorStrip tab={tab} />
      ) : result && result.columns.length > 0 ? (
        <ResultsGrid
          result={result}
          numericCols={numericCols}
          navByColumn={navByColumn}
        />
      ) : result ? (
        <div className="results__note">
          Query OK{result.commandTag ? ` · ${result.commandTag}` : ""}
        </div>
      ) : (
        <div className="results__note results__note--idle">
          {tab.running ? "Running…" : "Run a query to see results here."}
        </div>
      )}
    </div>
  );
}

function ResultsHeader({
  tab,
  result,
}: {
  tab: QueryTab;
  result: QueryResult | null;
}) {
  return (
    <div
      className={
        "results__header" + (tab.kind === "table" ? " results__header--filter" : "")
      }
    >
      <div className="results__header-left">
        {tab.kind === "table" ? (
          <FilterBar key={tab.id} tab={tab} />
        ) : (
          <>
            <span className="results__title">Results</span>
            {result && result.limitApplied && (
              <span
                className="results__limit mono"
                title="A default LIMIT 100 was applied to this unbounded SELECT."
              >
                LIMIT 100 applied
              </span>
            )}
          </>
        )}
      </div>
      <div className="results__header-right mono">
        {result && result.columns.length > 0 && (
          <>
            <span className="results__stat">
              <span className="results__dot" />
              {result.rowCount} {result.rowCount === 1 ? "row" : "rows"}
            </span>
            <span>·</span>
            <span>{result.elapsedMs} ms</span>
            <ResultsMenu onExportCsv={() => exportCsv(result, tab.title)} />
          </>
        )}
      </div>
    </div>
  );
}

/** The "more actions" (three-dots) menu in the results header. */
function ResultsMenu({ onExportCsv }: { onExportCsv: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div className="results__menu">
      <button
        className="results__menu-btn"
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          className="results__menu-dropdown"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="results__menu-item"
            onClick={() => {
              setOpen(false);
              onExportCsv();
            }}
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  );
}

type ColNav = { references: ForeignKeyRef[]; referencedBy: ForeignKeyRef[] };

function ResultsGrid({
  result,
  numericCols,
  navByColumn,
}: {
  result: QueryResult;
  numericCols: boolean[];
  navByColumn: ColNav[] | null;
}) {
  const openTableWithFilter = useStore((s) => s.openTableWithFilter);
  // Column layout — a display `order` (permutation of original column indices)
  // and per-column pixel `widths`. Both are shared by the header and every row
  // (so the rules line up), user-adjustable, and restored from a saved layout
  // for this exact set of columns.
  const signature = useMemo(() => layoutSignature(result.columns), [result]);
  const [order, setOrder] = useState<number[]>(() =>
    loadOrder(signature, result.columns),
  );
  const [widths, setWidths] = useState<number[]>(() =>
    loadWidths(signature, result, numericCols),
  );
  // Pointer-drag reorder state: dragged display position, live pointer delta,
  // and the position it would drop into.
  const [drag, setDrag] = useState<{
    fromPos: number;
    dx: number;
    targetPos: number;
  } | null>(null);
  // Selected cell, for highlighting and copy.
  const [selected, setSelected] = useState<{ r: number; col: number } | null>(
    null,
  );
  // Open FK "jump to referenced row" menu, anchored at the clicked cell.
  const [fkMenu, setFkMenu] = useState<{
    r: number;
    col: number;
    x: number;
    y: number;
  } | null>(null);
  // Client-side sort: original column index + direction, cycling default → asc
  // → desc → default. Sorts the loaded rows.
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(
    null,
  );

  useEffect(() => {
    setOrder(loadOrder(signature, result.columns));
    setWidths(loadWidths(signature, result, numericCols));
    setSelected(null);
    setFkMenu(null);
    setSort(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Dismiss the FK menu on any outside interaction. Cell/menu clicks stop
  // propagation, so this only fires for clicks elsewhere.
  useEffect(() => {
    if (!fkMenu) return;
    const close = () => setFkMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [fkMenu]);

  // Cmd/Ctrl+C copies the selected cell's value.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const value = result.rows[selected.r]?.[selected.col];
        void navigator.clipboard.writeText(value ?? "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, result]);

  const template = order.map((i) => `${widths[i]}px`).join(" ");
  const totalWidth = order.reduce((sum, i) => sum + widths[i], 0);
  const gridStyle = { gridTemplateColumns: template, width: totalWidth };
  const dragWidth = drag ? widths[order[drag.fromPos]] : 0;

  const startResize = (colIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[colIndex];
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
      setWidths((prev) => {
        const copy = [...prev];
        copy[colIndex] = next;
        return copy;
      });
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setWidths((w) => {
        persistLayout(signature, result.columns, order, w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Cycle a column's sort: default -> ascending -> descending -> default.
  const cycleSort = (col: number) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  };

  // A header press is either a click (sort) or a drag (reorder) — decided by
  // whether the pointer moves past a small threshold. Anywhere in the header
  // cell works; the drag animates the header row and reorders data on drop.
  const DRAG_THRESHOLD = 5;
  const onHeaderMouseDown = (pos: number, colIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let mids: number[] = [];

    const beginDrag = () => {
      const dispWidths = order.map((i) => widths[i]);
      mids = [];
      let acc = 0;
      for (const w of dispWidths) {
        mids.push(acc + w / 2);
        acc += w;
      }
      dragging = true;
      document.body.style.userSelect = "none";
      setDrag({ fromPos: pos, dx: 0, targetPos: pos });
    };

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) {
          return;
        }
        beginDrag();
      }
      const center = mids[pos] + dx;
      let target = pos;
      while (target < mids.length - 1 && center > mids[target + 1]) target += 1;
      while (target > 0 && center < mids[target - 1]) target -= 1;
      setDrag({ fromPos: pos, dx, targetPos: target });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!dragging) {
        // No drag happened — treat as a click to cycle the sort.
        cycleSort(colIndex);
        return;
      }
      document.body.style.userSelect = "";
      setDrag((d) => {
        if (d && d.fromPos !== d.targetPos) {
          setOrder((prev) => {
            const next = [...prev];
            const [moved] = next.splice(d.fromPos, 1);
            next.splice(d.targetPos, 0, moved);
            persistLayout(signature, result.columns, next, widths);
            return next;
          });
        }
        return null;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Row indices in display order (sorted client-side when a sort is active).
  const sortedRowIndices = useMemo(() => {
    const indices = result.rows.map((_, i) => i);
    if (!sort) return indices;
    const { col, dir } = sort;
    const numeric = numericCols[col];
    indices.sort((a, b) =>
      compareCells(result.rows[a][col], result.rows[b][col], numeric, dir),
    );
    return indices;
  }, [result, sort, numericCols]);

  // Transform for each header cell during a drag (the sliding animation).
  const headerStyle = (pos: number): React.CSSProperties => {
    if (!drag) return {};
    if (pos === drag.fromPos) {
      return {
        transform: `translateX(${drag.dx}px)`,
        transition: "none",
        zIndex: 3,
      };
    }
    if (drag.targetPos > drag.fromPos && pos > drag.fromPos && pos <= drag.targetPos) {
      return { transform: `translateX(${-dragWidth}px)` };
    }
    if (drag.targetPos < drag.fromPos && pos >= drag.targetPos && pos < drag.fromPos) {
      return { transform: `translateX(${dragWidth}px)` };
    }
    return {};
  };

  return (
    <div className="grid">
      <div className="grid__scroll">
        <div className="grid__head" style={gridStyle}>
          {order.map((colIndex, pos) => (
            <div
              key={colIndex}
              className={
                "grid__hcell" +
                (numericCols[colIndex] ? " grid__cell--num" : "") +
                (drag ? " grid__hcell--sliding" : "") +
                (drag && drag.fromPos === pos ? " grid__hcell--dragging" : "")
              }
              style={headerStyle(pos)}
              onMouseDown={onHeaderMouseDown(pos, colIndex)}
              title="Click to sort · drag to reorder"
            >
              <span className="grid__hlabel">
                {result.columns[colIndex].name}
              </span>
              {sort?.col === colIndex && (
                <span className="grid__sort">
                  {sort.dir === "asc" ? "▲" : "▼"}
                </span>
              )}
              <span
                className="grid__resizer"
                onMouseDown={startResize(colIndex)}
                title="Drag to resize"
              />
            </div>
          ))}
        </div>
        {result.rows.length === 0 && (
          <div className="results__note results__note--sub">No rows returned.</div>
        )}
        {sortedRowIndices.map((r, displayPos) => {
          const row = result.rows[r];
          return (
          <div
            key={r}
            className={
              "grid__row" +
              (displayPos % 2 === 1 ? " grid__row--zebra" : "") +
              (selected?.r === r ? " grid__row--active" : "")
            }
            style={gridStyle}
          >
            {order.map((colIndex) => {
              const value = row[colIndex];
              const isSelected = selected?.r === r && selected?.col === colIndex;
              const nav = navByColumn?.[colIndex];
              const isFk =
                !!nav &&
                value !== null &&
                (nav.references.length > 0 || nav.referencedBy.length > 0);
              return (
                <div
                  key={colIndex}
                  className={
                    "grid__cell" +
                    (numericCols[colIndex] ? " grid__cell--num mono" : "") +
                    (value === null ? " grid__cell--null" : "") +
                    (isSelected ? " grid__cell--selected" : "") +
                    (isFk ? " grid__cell--fk" : "")
                  }
                  title={isFk ? fkTooltip(nav!) : value ?? "NULL"}
                  onClick={() => setSelected({ r, col: colIndex })}
                  onContextMenu={(e) => {
                    if (!isFk) return;
                    e.preventDefault();
                    setSelected({ r, col: colIndex });
                    setFkMenu({ r, col: colIndex, x: e.clientX, y: e.clientY });
                  }}
                >
                  {value === null ? "NULL" : value}
                </div>
              );
            })}
          </div>
          );
        })}
      </div>

      {fkMenu &&
        (() => {
          const nav = navByColumn?.[fkMenu.col];
          const value = result.rows[fkMenu.r]?.[fkMenu.col];
          if (!nav || value == null) return null;
          if (nav.references.length === 0 && nav.referencedBy.length === 0) {
            return null;
          }
          const openRef = (ref: ForeignKeyRef) => {
            setFkMenu(null);
            void openTableWithFilter(
              ref.schema,
              ref.table,
              `${ref.column} = '${value.replace(/'/g, "''")}'`,
            );
          };
          const item = (ref: ForeignKeyRef, key: string) => (
            <button
              key={key}
              className="context-menu__item context-menu__item--fk"
              onClick={() => openRef(ref)}
            >
              <span>{ref.table}</span>
              <span className="context-menu__sub mono">
                {ref.schema}.{ref.column}
              </span>
            </button>
          );
          return (
            <div
              className="context-menu"
              style={{ left: fkMenu.x, top: fkMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              {nav.references.length > 0 && (
                <>
                  <div className="context-menu__label">Jump to referenced row</div>
                  {nav.references.map((ref, i) => item(ref, `out-${i}`))}
                </>
              )}
              {nav.referencedBy.length > 0 && (
                <>
                  <div className="context-menu__label">Rows referencing this</div>
                  {nav.referencedBy.map((ref, i) => item(ref, `in-${i}`))}
                </>
              )}
            </div>
          );
        })()}
    </div>
  );
}

/** Tooltip describing a cell's foreign-key navigation. */
function fkTooltip(nav: ColNav): string {
  const parts: string[] = [];
  if (nav.references.length > 0) {
    parts.push(`References ${nav.references[0].table}`);
  }
  if (nav.referencedBy.length > 0) {
    const n = nav.referencedBy.length;
    parts.push(`Referenced by ${n} ${n === 1 ? "table" : "columns"}`);
  }
  return parts.join(" · ") + " — right-click to navigate";
}

/** Inline, calm error strip anchored where results would appear (per spec). */
function ErrorStrip({ tab }: { tab: QueryTab }) {
  const err = tab.error!;
  const detailParts = [
    err.code ? `ERROR ${err.code}` : null,
    err.position != null ? `position ${err.position}` : null,
    err.hint ?? null,
  ].filter(Boolean);

  return (
    <div className="error-strip">
      <span className="error-strip__glyph">✕</span>
      <div className="error-strip__body">
        <span className="error-strip__message">{err.message}</span>
        {detailParts.length > 0 && (
          <span className="error-strip__detail mono">
            {detailParts.join(" · ")}
          </span>
        )}
        <div className="error-strip__actions">
          <button
            className="error-strip__btn"
            onClick={() => void navigator.clipboard.writeText(err.message)}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

const MIN_COL_WIDTH = 56;
const MAX_INITIAL_WIDTH = 420;
const CHAR_PX = 7.6; // approximate width of one mono/sans character
const CELL_PADDING = 26;
const WIDTH_SAMPLE_ROWS = 40;

/** Estimate a sensible starting width per column from its header and content. */
function initialWidths(result: QueryResult, numericCols: boolean[]): number[] {
  const sample = result.rows.slice(0, WIDTH_SAMPLE_ROWS);
  return result.columns.map((col, i) => {
    let maxChars = col.name.length;
    for (const row of sample) {
      const v = row[i];
      if (v != null && v.length > maxChars) maxChars = v.length;
    }
    const floor = numericCols[i] ? 72 : 96;
    const estimate = Math.round(maxChars * CHAR_PX + CELL_PADDING);
    return Math.max(floor, Math.min(MAX_INITIAL_WIDTH, estimate));
  });
}

// --- persisted column layout (order + widths), keyed by the column-name set ---

const LAYOUT_KEY = "cubbydb:colLayout";
type SavedLayout = { order: string[]; widths: Record<string, number> };

function layoutSignature(columns: { name: string }[]): string {
  return columns.map((c) => c.name).join("");
}
function columnsUnique(columns: { name: string }[]): boolean {
  return new Set(columns.map((c) => c.name)).size === columns.length;
}
function readLayouts(): Record<string, SavedLayout> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  } catch {
    return {};
  }
}
function persistLayout(
  signature: string,
  columns: { name: string }[],
  order: number[],
  widths: number[],
) {
  // Only persist when names are unique (otherwise name<->index is ambiguous).
  if (!columnsUnique(columns)) return;
  try {
    const all = readLayouts();
    const widthsByName: Record<string, number> = {};
    columns.forEach((c, i) => (widthsByName[c.name] = widths[i]));
    all[signature] = { order: order.map((i) => columns[i].name), widths: widthsByName };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable — non-fatal.
  }
}
function loadOrder(signature: string, columns: { name: string }[]): number[] {
  const def = columns.map((_, i) => i);
  if (!columnsUnique(columns)) return def;
  const saved = readLayouts()[signature];
  if (!saved || !Array.isArray(saved.order)) return def;
  const nameToIndex = new Map(columns.map((c, i) => [c.name, i]));
  const order: number[] = [];
  for (const name of saved.order) {
    const idx = nameToIndex.get(name);
    if (idx === undefined) return def; // columns changed — fall back
    order.push(idx);
  }
  return order.length === columns.length ? order : def;
}
function loadWidths(
  signature: string,
  result: QueryResult,
  numericCols: boolean[],
): number[] {
  const def = initialWidths(result, numericCols);
  const saved = readLayouts()[signature];
  if (!saved || !saved.widths) return def;
  return result.columns.map((c, i) => saved.widths[c.name] ?? def[i]);
}

/** Compare two cell values for sorting. NULLs always sort last. */
function compareCells(
  a: string | null,
  b: string | null,
  numeric: boolean,
  dir: "asc" | "desc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const r = numeric ? parseFloat(a) - parseFloat(b) : a.localeCompare(b);
  return dir === "asc" ? r : -r;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function inferNumericColumns(result: QueryResult): boolean[] {
  return result.columns.map((_, i) => {
    let seen = false;
    for (const row of result.rows) {
      const v = row[i];
      if (v == null || v === "") continue;
      seen = true;
      if (!NUMERIC_RE.test(v)) return false;
    }
    return seen;
  });
}

function toCsv(result: QueryResult): string {
  const escape = (v: string | null): string => {
    if (v === null) return "";
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const header = result.columns.map((c) => escape(c.name)).join(",");
  const body = result.rows.map((row) => row.map(escape).join(",")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

function exportCsv(result: QueryResult, tabTitle: string) {
  const csv = toCsv(result);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tabTitle.replace(/\.sql$/, "") || "results"}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
