import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CopyResult } from "../../api/backend";
import { copyToClipboard, errorMessage, readClipboard } from "../../api/backend";
import { parseCsv, saveCsv } from "../../lib/csv";
import { bestMatch } from "../../lib/fuzzyMatch";
import { matchesKeybinding, useKeybindingStore } from "../../lib/keybindings";
import type { Delimiter, QueryTab } from "../../state/store";
import { useActiveSchema, useStore } from "../../state/store";
import {
  accentPaletteFor,
  NULL_DISPLAY_LABELS,
  PAGE_SIZE,
  tabHasPendingEdits,
  THEME_MODE,
} from "../../state/store";
import type { ForeignKeyRef, QueryResult } from "../../types";
import { FilterBar } from "./FilterBar";
import { PendingEditsBar } from "./PendingEditsBar";

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

  // Same inference approach, for displaying Postgres's `t`/`f` boolean text
  // form as `true`/`false` — see `inferBooleanColumns`'s doc comment.
  const booleanCols = useMemo(
    () => (result ? inferBooleanColumns(result) : []),
    [result],
  );

  // For table tabs, map each result column to its foreign keys in both
  // directions (from the schema): outgoing (this cell points at another row) and
  // incoming (other tables point at this row).
  const schema = useActiveSchema();
  const schemaTable = useMemo(() => {
    if (tab.kind !== "table" || !tab.source) return null;
    return (
      schema
        .find((s) => s.name === tab.source!.schema)
        ?.tables.find((t) => t.name === tab.source!.table) ?? null
    );
  }, [schema, tab]);

  const navByColumn = useMemo(() => {
    if (!result || !schemaTable) return null;
    const byName = new Map(schemaTable.columns.map((c) => [c.name, c]));
    return result.columns.map((c) => {
      const col = byName.get(c.name);
      return {
        references: sortByTable(col?.references),
        referencedBy: sortByTable(col?.referencedBy),
      };
    });
  }, [result, schemaTable]);

  // Cells are editable only for table tabs backed by a real table (not a
  // view) with at least one detected primary key — otherwise show why not.
  const editability = useMemo(() => {
    if (!schemaTable) return null;
    const pkNames = new Set(
      schemaTable.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    );
    if (schemaTable.kind === "view") {
      return { editable: false, reason: "View — read-only", pkNames };
    }
    if (pkNames.size === 0) {
      return {
        editable: false,
        reason: "No primary key detected — read-only",
        pkNames,
      };
    }
    return { editable: true, reason: null, pkNames };
  }, [schemaTable]);

  const pkColIndices = useMemo(() => {
    if (!result || !editability) return new Set<number>();
    return new Set(
      result.columns
        .map((c, i) => (editability.pkNames.has(c.name) ? i : -1))
        .filter((i) => i >= 0),
    );
  }, [result, editability]);

  // Which result columns map to nullable table columns (for the "Set to NULL"
  // action — only nullable columns can accept it).
  const nullableColIndices = useMemo(() => {
    if (!result || !schemaTable) return new Set<number>();
    const nullableNames = new Set(
      schemaTable.columns.filter((c) => c.nullable).map((c) => c.name),
    );
    return new Set(
      result.columns
        .map((c, i) => (nullableNames.has(c.name) ? i : -1))
        .filter((i) => i >= 0),
    );
  }, [result, schemaTable]);

  // A tagged connection (set in its own edit form) tints this whole pane —
  // a thin border by default, or a flatter full-tint fill if that
  // connection was set up to use the louder style instead.
  const connColor = useStore((s) => {
    const id = s.activeConnectionId;
    return id ? (s.connections[id]?.color ?? null) : null;
  });
  const connectionColorStyle = useStore((s) => {
    const id = s.activeConnectionId;
    return id ? (s.connections[id]?.colorStyle ?? "border") : "border";
  });
  const theme = useStore((s) => s.theme);
  const connPalette = connColor ? accentPaletteFor(connColor, THEME_MODE[theme]) : null;
  const connStyle = connPalette
    ? ({
        "--conn-color": connPalette.accent,
        "--conn-color-tint": connPalette.accentTint,
      } as React.CSSProperties)
    : undefined;

  // A read-only alternate layout — columns become rows, rows become
  // columns — for eyeballing a wide row or comparing a few rows' worth of
  // columns vertically. Local to this pane (which remounts per tab, see
  // `key={activeTab.id}` in Workspace.tsx), so it's a per-tab view choice,
  // not a setting that would follow every other tab.
  const [transposed, setTransposed] = useState(false);
  const nullDisplay = useStore((s) => s.nullDisplay);
  const nullText = NULL_DISPLAY_LABELS[nullDisplay];

  return (
    <div
      className={"results" + (connPalette ? ` results--conn-${connectionColorStyle}` : "")}
      style={connStyle}
    >
      <ResultsHeader
        tab={tab}
        result={result}
        readOnlyReason={editability?.reason ?? null}
        transposed={transposed}
        onToggleTranspose={() => setTransposed((t) => !t)}
      />

      {tab.error ? (
        <ErrorStrip tab={tab} />
      ) : result && result.columns.length > 0 ? (
        transposed ? (
          <TransposedGrid
            result={result}
            numericCols={numericCols}
            booleanCols={booleanCols}
            nullText={nullText}
          />
        ) : (
          <ResultsGrid
            tab={tab}
            result={result}
            numericCols={numericCols}
            booleanCols={booleanCols}
            navByColumn={navByColumn}
            editable={editability?.editable ?? false}
            pkColIndices={pkColIndices}
            nullableColIndices={nullableColIndices}
          />
        )
      ) : result ? (
        <div className="results__note">
          Query OK{result.commandTag ? ` · ${result.commandTag}` : ""}
        </div>
      ) : (
        <div className="results__note results__note--idle">
          {tab.running ? "Running…" : "Run a query to see results here."}
        </div>
      )}

      {tab.updateError && <MutationErrorBar tab={tab} />}
      {tabHasPendingEdits(tab) && <PendingEditsBar tab={tab} />}
    </div>
  );
}

function ResultsHeader({
  tab,
  result,
  readOnlyReason,
  transposed,
  onToggleTranspose,
}: {
  tab: QueryTab;
  result: QueryResult | null;
  readOnlyReason: string | null;
  transposed: boolean;
  onToggleTranspose: () => void;
}) {
  const csvDelimiter = useStore((s) => s.csvDelimiter);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const silentRefreshTabId = useStore((s) => s.silentRefreshTabId);
  // A background refresh (Cmd/Ctrl+R, the Refresh button) of a tab that
  // already has data on screen shouldn't yank the stats away in favor of the
  // "Running…/Cancel" takeover below — that's built for a genuine new run,
  // where there's nothing else worth showing yet.
  const showRunningTakeover = tab.running && silentRefreshTabId !== tab.id;
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
                title="This query has its own LIMIT, so the rest of the result can't be paged through. Remove it to page."
              >
                Limit applied
              </span>
            )}
          </>
        )}
      </div>
      <div className="results__header-right mono">
        {readOnlyReason && (
          <span className="results__readonly" title={readOnlyReason}>
            Read-only
          </span>
        )}
        {showRunningTakeover ? (
          <span className="results__running">
            <span className="spinner" />
            Running…
            <button
              className="results__cancel"
              onClick={cancelQuery}
              title="Cancel this query (Esc)"
            >
              Cancel
            </button>
          </span>
        ) : (
          result &&
          result.columns.length > 0 && (
            <>
              <span className="results__stat">
                <span className="results__dot" />
                {result.rowCount} {result.rowCount === 1 ? "row" : "rows"}
              </span>
              <span>·</span>
              <span>{result.elapsedMs} ms</span>
              <ResultsMenu
                onExportCsv={() => exportCsv(result, tab.title, csvDelimiter)}
                transposed={transposed}
                onToggleTranspose={onToggleTranspose}
              />
            </>
          )
        )}
      </div>
    </div>
  );
}

/** The "more actions" (three-dots) menu in the results header. */
function ResultsMenu({
  onExportCsv,
  transposed,
  onToggleTranspose,
}: {
  onExportCsv: () => void;
  transposed: boolean;
  onToggleTranspose: () => void;
}) {
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
          <button
            className="results__menu-item results__menu-item--check"
            title="Flip rows and columns for this view — read-only, and just for the tab you're looking at"
            onClick={() => {
              setOpen(false);
              onToggleTranspose();
            }}
          >
            Transpose
            {transposed && <span className="results__menu-check">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}

type ColNav = { references: ForeignKeyRef[]; referencedBy: ForeignKeyRef[] };

/** Alphabetical by table name (then column, for the rare case of two FKs into
 *  the same table) — the schema's own declaration order isn't meaningful to a
 *  user scanning the FK menu for a specific table. */
function sortByTable(refs: ForeignKeyRef[] | undefined): ForeignKeyRef[] {
  if (!refs || refs.length < 2) return refs ?? [];
  return [...refs].sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  );
}

// In-app cell clipboard, so copy/paste can preserve SQL NULL (which the system
// text clipboard can't represent). `text` is what was also written to the OS
// clipboard, used to detect whether a paste came from an in-app copy.
let cellClipboard: { text: string; value: string | null } | null = null;

// In-app whole-row clipboard: one or more rows, each aligned to original column
// order, for copying rows and pasting them over another row or as duplicates.
// Preserves NULLs like the cell clipboard.
let rowClipboard: Array<Array<string | null>> | null = null;

/** A selected whole row: an existing result row or a pending draft row. */
type RowSelection = { kind: "existing" | "new"; index: number };

/** Width of the left row-number / selection gutter. */
const GUTTER_W = 48;

/** Keep-inside-the-viewport geometry for the FK context menu. `FK_MENU_W`
 *  must match `.context-menu--fk`'s `max-width` in workspace.css — the menu is
 *  otherwise sized by its content, and clamping against a guessed width lets
 *  a long table name push it off the right edge. */
const FK_MENU_MARGIN = 12;
const FK_MENU_MIN_H = 180;
const FK_MENU_W = 460;

/**
 * Place the FK menu at the click point but always fully on screen. A row can
 * be referenced by dozens of tables (a `businessId` fanning out across a
 * schema is the normal case, not the pathological one), so the menu is capped
 * to the space it actually has — it flips to open upward when there's more
 * room above the click — and scrolls internally past that, rather than
 * running off the bottom of the window where the rest is unreachable.
 */
function fkMenuStyle(x: number, y: number): React.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(FK_MENU_MARGIN, Math.min(x, vw - FK_MENU_W - FK_MENU_MARGIN));
  const below = vh - y - FK_MENU_MARGIN;
  const above = y - FK_MENU_MARGIN;
  if (below < FK_MENU_MIN_H && above > below) {
    return { left, bottom: vh - y, maxHeight: above };
  }
  return { left, top: y, maxHeight: below };
}
/** `.grid__head`'s CSS height, used only as a pre-measurement fallback. */
const HEAD_H = 30;

/** Below this many rows, render everything — small results are already fast
 *  and this keeps the simple path simple. */
const VIRTUALIZE_MIN_ROWS = 80;
/** Likewise for columns: a narrow table's cells all fit on screen anyway, so
 *  windowing them would only add spacer-track bookkeeping. */
const VIRTUALIZE_MIN_COLS = 16;
/**
 * Rows/columns rendered beyond each edge of the viewport. This is the buffer
 * that decides whether a fast scroll shows blank space: the browser scrolls
 * and repaints on its own (compositor) timeline, while React only catches up
 * a frame or more later via the `scroll` event — so anything the user flings
 * past within that gap must already be rendered. At the default 32px row
 * that's ~1920px of vertical runway in each direction.
 *
 * A fixed buffer can only ever cover a fixed distance, though, and a hard
 * trackpad fling covers several thousand pixels between two frames — which
 * is what still showed blank rows. `leadRowsFor` below extends it in the
 * direction of travel instead, so the buffer grows with how fast the content
 * is actually moving.
 */
const VIRTUALIZE_OVERSCAN = 60;
const COL_OVERSCAN = 4;
/**
 * Extra rows rendered *ahead* of a moving scroll, on top of the fixed
 * overscan. Reactive windowing always lands a frame or more behind the
 * compositor, so the only way to stay ahead of a fling is to render where it
 * is going rather than where it has been.
 *
 * Scaled to how far the last frame actually travelled, and capped so a
 * violent fling can't try to render the whole result at once — beyond the
 * cap the grid degrades to showing blank briefly, which is far better than
 * blocking the main thread on a 10,000-row render.
 */
const MAX_LEAD_ROWS = 220;

/** Rows to render ahead, for a scroll moving `velocity` px per frame. */
function leadRowsFor(velocity: number, rowH: number): number {
  if (rowH <= 0) return 0;
  return Math.min(Math.ceil(Math.abs(velocity) / rowH), MAX_LEAD_ROWS);
}
/**
 * The window is snapped to multiples of these, so a scroll only re-renders
 * once it has moved a whole block rather than on every event. The overscan
 * above covers the block, and this is what keeps a slow drag-scroll from
 * re-rendering ~60 times a second.
 */
const ROW_BLOCK = 8;
const COL_BLOCK = 4;

/** The rendered slice of the grid: rows `[startIdx, endIdx)` in display order,
 *  columns `[startCol, endCol)` in display order. */
type Win = { startIdx: number; endIdx: number; startCol: number; endCol: number };

function sameWin(a: Win, b: Win): boolean {
  return (
    a.startIdx === b.startIdx &&
    a.endIdx === b.endIdx &&
    a.startCol === b.startCol &&
    a.endCol === b.endCol
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const snapDown = (v: number, block: number) => Math.floor(v / block) * block;
const snapUp = (v: number, block: number) => Math.ceil(v / block) * block;

/**
 * Display position of the column whose span contains `x`, where `starts` is
 * the prefix-sum of column widths (length = column count + 1). Binary search
 * rather than a scan because this runs on the scroll path.
 */
function colAt(starts: number[], x: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Read-only transposed view of the current result: one column per loaded
 * row, one row per result column — for eyeballing a wide row's many columns
 * top-to-bottom, or comparing a handful of rows side by side. A plain HTML
 * table rather than the windowed/virtualized main grid: nothing here is
 * editable, sortable, or FK-navigable, so none of that machinery earns its
 * keep, and a page's worth of rows (`PAGE_SIZE`) is small enough to render
 * in one pass.
 */
function TransposedGrid({
  result,
  numericCols,
  booleanCols,
  nullText,
}: {
  result: QueryResult;
  numericCols: boolean[];
  booleanCols: boolean[];
  nullText: string;
}) {
  return (
    <div className="transpose-scroll">
      <table className="transpose-table">
        <thead>
          <tr>
            <th className="transpose-table__corner" />
            {result.rows.map((_, i) => (
              <th key={i} className="transpose-table__rownum mono">
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.columns.map((col, colIndex) => (
            <tr key={col.name}>
              <th className="transpose-table__colname mono">{col.name}</th>
              {result.rows.map((row, r) => {
                const value = row[colIndex];
                const display =
                  booleanCols[colIndex] && value === "t"
                    ? "true"
                    : booleanCols[colIndex] && value === "f"
                      ? "false"
                      : value;
                return (
                  <td
                    key={r}
                    className={
                      "transpose-table__cell" +
                      (numericCols[colIndex] ? " mono transpose-table__cell--num" : "") +
                      (value === null ? " transpose-table__cell--null" : "")
                    }
                    title={display ?? "NULL"}
                  >
                    {display === null ? nullText : display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultsGrid({
  tab,
  result,
  numericCols,
  booleanCols,
  navByColumn,
  editable,
  pkColIndices,
  nullableColIndices,
}: {
  tab: QueryTab;
  result: QueryResult;
  numericCols: boolean[];
  booleanCols: boolean[];
  navByColumn: ColNav[] | null;
  editable: boolean;
  pkColIndices: Set<number>;
  nullableColIndices: Set<number>;
}) {
  const openTableWithFilter = useStore((s) => s.openTableWithFilter);
  const nullDisplay = useStore((s) => s.nullDisplay);
  const nullText = NULL_DISPLAY_LABELS[nullDisplay];
  const rowCopyDelimiter = useStore((s) => s.rowCopyDelimiter);
  const tableRowHeight = useStore((s) => s.tableRowHeight);
  const tableWrapText = useStore((s) => s.tableWrapText);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const findBinding = useKeybindingStore((s) => s.bindings["results.find"]);
  const jumpColumnBinding = useKeybindingStore(
    (s) => s.bindings["results.jumpColumn"],
  );
  const setCellEdit = useStore((s) => s.setCellEdit);
  const setNewCellEdit = useStore((s) => s.setNewCellEdit);
  const overwriteRow = useStore((s) => s.overwriteRow);
  const addRow = useStore((s) => s.addRow);
  const addRows = useStore((s) => s.addRows);
  const removeNewRow = useStore((s) => s.removeNewRow);
  const deleteExistingRows = useStore((s) => s.deleteExistingRows);
  const setTablePage = useStore((s) => s.setTablePage);
  const setQueryPage = useStore((s) => s.setQueryPage);
  const csvDelimiter = useStore((s) => s.csvDelimiter);
  const setUpdateError = useStore((s) => s.setUpdateError);
  const isTable = tab.kind === "table";
  // Column layout — a display `order` (permutation of original column indices)
  // and per-column pixel `widths`. Both are shared by the header and every row
  // (so the rules line up), user-adjustable, and restored from a saved layout
  // for this exact set of columns.
  const signature = useMemo(() => layoutSignature(result.columns), [result]);
  const [orderState, setOrder] = useState<number[]>(() =>
    loadOrder(signature, result.columns),
  );
  const [widthsState, setWidths] = useState<number[]>(() =>
    loadWidths(signature, result, numericCols),
  );
  // The signature `orderState`/`widthsState` were last derived for.
  const [layoutSig, setLayoutSig] = useState(signature);

  // Re-derive the column layout *during* render — deliberately not in the
  // `[result]` effect further down — whenever the result's column set
  // changes. An effect only runs after the render it belongs to has already
  // committed, so re-running a tab against a different table (highlight a
  // second statement, hit run) spent one full render with the *previous*
  // result's `order`/`widths`: every entry in them is an index into a column
  // list that no longer has those slots. On a narrower new result that took
  // the header out with `result.columns[colIndex].name` of undefined, killing
  // the whole pane. Deriving here means this render already sees a layout
  // that matches `result`; the `setState` calls just persist it for the next
  // one (React re-runs the component immediately, before committing, rather
  // than scheduling a second visible pass).
  let order = orderState;
  let widths = widthsState;
  if (layoutSig !== signature) {
    order = loadOrder(signature, result.columns);
    widths = loadWidths(signature, result, numericCols);
    setLayoutSig(signature);
    setOrder(order);
    setWidths(widths);
  }
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
  // Selected whole rows (via the gutter), for row copy/paste and remove. Holds
  // one or more rows; `rowAnchorRef` is the pivot for shift-click ranges.
  const [rowSel, setRowSel] = useState<RowSelection[]>([]);
  const rowAnchorRef = useRef<RowSelection | null>(null);
  // Open FK "jump to referenced row" menu, anchored at the clicked cell.
  const [fkMenu, setFkMenu] = useState<{
    r: number;
    col: number;
    x: number;
    y: number;
  } | null>(null);
  // Filters the FK menu's table list — a row can be referenced by dozens of
  // tables, so typing narrows it rather than requiring a scroll-and-scan.
  const [fkQuery, setFkQuery] = useState("");
  const fkQueryRef = useRef<HTMLInputElement>(null);
  // The cell "Expand" opened from the same right-click menu, shown in
  // `CellInspectorDialog` below — a full-size, read-only, JSON-aware view
  // for a value too long to read in a 32px-tall grid cell.
  const [expandedCell, setExpandedCell] = useState<{
    value: string | null;
    columnName: string;
  } | null>(null);
  // Sort state, cycling default → asc → desc → default. For `table` tabs this
  // is a real `ORDER BY` applied by the backend (persisted on the tab as
  // `sortColumn`/`sortDesc` via `setTableSort`) so it covers every row in the
  // table, not just whichever page happens to be loaded — client-side sort
  // over just the current page silently gave the wrong order for anything
  // past the first page. Other tab kinds have no backing table to re-query,
  // and their results are never paginated (loaded in full, up to the safety
  // cap), so a plain client-side sort over what's already loaded is correct.
  const setTableSort = useStore((s) => s.setTableSort);
  const [localSort, setLocalSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(
    null,
  );
  // Memoized so `sort` is a stable reference across renders that don't
  // actually change any of its inputs — `sortedRowIndices` below depends on
  // it, and without this it was a fresh object literal every render (any
  // render, for any reason — a keystroke, a scroll), which defeated that
  // memo and re-sorted every row of the result on every single one.
  const sort = useMemo(
    () =>
      isTable
        ? tab.sortColumn != null
          ? {
              col: result.columns.findIndex((c) => c.name === tab.sortColumn),
              dir: (tab.sortDesc ? "desc" : "asc") as "asc" | "desc",
            }
          : null
        : localSort,
    [isTable, tab.sortColumn, tab.sortDesc, result.columns, localSort],
  );
  // The cell currently swapped for an inline edit input, if any. `isNew` marks
  // a draft (not-yet-inserted) row, whose edits go to `setNewCellEdit`.
  const [editing, setEditing] = useState<{
    r: number;
    col: number;
    draft: string;
    isNew?: boolean;
  } | null>(null);

  // Find-in-results (Cmd/Ctrl+F) state; the matches themselves are computed
  // further down, once `sortedRowIndices` (display row order) exists.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Jump-to-column (Cmd/Ctrl+G) — scrolls a wide, horizontally-scrolled grid
  // to bring a named column into view, rather than searching cell values
  // like Find does. Mutually exclusive with Find (see the shared keydown
  // handler below) so the two overlays never stack.
  const [colJumpOpen, setColJumpOpen] = useState(false);
  const [colJumpQuery, setColJumpQuery] = useState("");
  const [colJumpSelected, setColJumpSelected] = useState(0);
  const colJumpInputRef = useRef<HTMLInputElement>(null);
  // Same reasoning as CommandPalette's mouseArmedRef: on open (and on every
  // query change that reflows the list), the browser fires `mouseenter` on
  // whatever row ends up under an already-stationary cursor, which would
  // otherwise steal the keyboard-driven selection away from row 0. Hover
  // only starts choosing a row once the mouse has demonstrably moved since
  // the list last reset.
  const colJumpMouseArmedRef = useRef(false);

  const isRowSelected = (kind: "existing" | "new", index: number) =>
    rowSel.some((s) => s.kind === kind && s.index === index);

  /** Select a single row (replacing any existing selection). */
  const selectRow = (sel: RowSelection) => {
    setRowSel([sel]);
    rowAnchorRef.current = sel;
    setSelected(null);
    setFkMenu(null);
  };

  // Row indices in display order (sorted client-side when a sort is active).
  // Guard against a stale sort column left over from a different result (e.g.
  // switching tabs) — treat an out-of-range column as "no sort" rather than
  // indexing past the row, which previously crashed the whole render tree.
  // Declared up here (rather than down near the rest of the find/sort logic,
  // where it used to live) since `selectRowFromGutter` right below needs it
  // in a `useCallback` dependency array, which — unlike a plain closure —
  // TypeScript's block-scoping requires to already be declared at this point
  // in the source, not just by the time the callback actually runs.
  const sortedRowIndices = useMemo(() => {
    const indices = result.rows.map((_, i) => i);
    // `table` tabs' sort is a real `ORDER BY` — the backend already returned
    // these rows in the right order, so sorting again here would just be
    // reapplying (usually redundant, but not guaranteed to agree with SQL's
    // own collation/NULL ordering) on top of it.
    if (isTable) return indices;
    if (!sort || sort.col < 0 || sort.col >= result.columns.length) return indices;
    const { col, dir } = sort;
    const numeric = numericCols[col];
    indices.sort((a, b) =>
      compareCells(result.rows[a][col], result.rows[b][col], numeric, dir),
    );
    return indices;
  }, [result, sort, numericCols, isTable]);

  /**
   * Gutter click with modifiers: plain = select just this row, ⌘/Ctrl+click =
   * toggle it in/out of the selection, Shift+click = select the range from the
   * anchor (existing rows only, in display order). Wrapped in `useCallback`
   * (and the two thin per-kind wrappers below it) so `GridRow`/`GridNewRow`
   * receive a referentially stable handler prop — required for their
   * `memo()` to actually skip re-rendering rows a click didn't touch.
   */
  const selectRowFromGutter = useCallback(
    (e: React.MouseEvent, kind: "existing" | "new", index: number) => {
      const sel: RowSelection = { kind, index };
      const anchor = rowAnchorRef.current;
      if (e.shiftKey && anchor && anchor.kind === "existing" && kind === "existing") {
        const aPos = sortedRowIndices.indexOf(anchor.index);
        const cPos = sortedRowIndices.indexOf(index);
        if (aPos >= 0 && cPos >= 0) {
          const [lo, hi] = aPos <= cPos ? [aPos, cPos] : [cPos, aPos];
          setRowSel(
            sortedRowIndices
              .slice(lo, hi + 1)
              .map((ri) => ({ kind: "existing" as const, index: ri })),
          );
        } else {
          setRowSel([sel]);
          rowAnchorRef.current = sel;
        }
      } else if (e.metaKey || e.ctrlKey) {
        setRowSel((prev) =>
          prev.some((s) => s.kind === kind && s.index === index)
            ? prev.filter((s) => !(s.kind === kind && s.index === index))
            : [...prev, sel],
        );
        rowAnchorRef.current = sel;
      } else {
        setRowSel([sel]);
        rowAnchorRef.current = sel;
      }
      setSelected(null);
      setFkMenu(null);
    },
    [sortedRowIndices],
  );
  const onExistingGutterClick = useCallback(
    (e: React.MouseEvent, r: number) => selectRowFromGutter(e, "existing", r),
    [selectRowFromGutter],
  );
  const onNewGutterClick = useCallback(
    (e: React.MouseEvent, ni: number) => selectRowFromGutter(e, "new", ni),
    [selectRowFromGutter],
  );

  // Cell selection/editing/context-menu handlers, likewise stable — each
  // takes the row/col as arguments rather than closing over them, so one
  // shared instance works for every row.
  const onCellClick = useCallback((r: number, col: number) => {
    setSelected({ r, col });
    setRowSel([]);
  }, []);
  // Escape and clicking the empty corner (gutter/header intersection) both
  // just clear whatever's selected — same "unhighlight the row and column"
  // outcome as clicking elsewhere in the grid, without needing a live target
  // to click on.
  const clearSelection = useCallback(() => {
    setSelected(null);
    setRowSel([]);
    rowAnchorRef.current = null;
    setFkMenu(null);
  }, []);
  const onCellDoubleClick = useCallback(
    (r: number, col: number, currentValue: string | null) => {
      setEditing({ r, col, draft: currentValue ?? "" });
    },
    [],
  );
  const onCellContextMenu = useCallback((e: React.MouseEvent, r: number, col: number) => {
    setSelected({ r, col });
    setFkMenu({ r, col, x: e.clientX, y: e.clientY });
    setFkQuery("");
  }, []);
  const onNewCellClick = useCallback((ni: number, col: number, currentValue: string | null) => {
    setEditing({ r: ni, col, draft: currentValue ?? "", isNew: true });
  }, []);
  const onEditDraftChange = useCallback(
    (r: number, col: number, draft: string, isNew?: boolean) => {
      setEditing({ r, col, draft, isNew });
    },
    [],
  );
  const onEditCommit = useCallback(
    (r: number, col: number, draft: string, isNew?: boolean) => {
      if (isNew) {
        setNewCellEdit(tab.id, r, col, draft === "" ? null : draft);
      } else {
        setCellEdit(tab.id, r, col, draft);
      }
      setEditing(null);
    },
    [tab.id, setNewCellEdit, setCellEdit],
  );
  const onEditCancel = useCallback(() => setEditing(null), []);

  // On-screen copy diagnostics: shows the value and which clipboard method
  // worked/failed for a few seconds after each copy.
  const [copyStatus, setCopyStatus] = useState<CopyResult | null>(null);
  const copyStatusTimer = useRef<number | null>(null);
  const showCopyStatus = useCallback((res: CopyResult) => {
    setCopyStatus(res);
    if (copyStatusTimer.current) window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyStatus(null), 4500);
  }, []);
  useEffect(
    () => () => {
      if (copyStatusTimer.current) window.clearTimeout(copyStatusTimer.current);
    },
    [],
  );

  // Per-result state that only ever *reads* the new result defensively (or
  // not at all), so clearing it one render late is harmless. `order`/`widths`
  // are deliberately not here — see the render-time derivation above for why
  // they can't wait for an effect.
  useEffect(() => {
    setSelected(null);
    setRowSel([]);
    rowAnchorRef.current = null;
    setFkMenu(null);
    setLocalSort(null);
    setEditing(null);
    setFindOpen(false);
    setFindQuery("");
  }, [result]);

  // Dismiss the FK menu on any outside interaction. Cell/menu clicks stop
  // propagation, so this only fires for clicks elsewhere.
  const fkMenuRef = useRef<HTMLDivElement>(null);
  // Locked to the menu's rendered width the instant it opens (full,
  // unfiltered list — `fkQuery` is always reset to "" in the same click that
  // opens it), so filtering down to shorter table names afterward doesn't
  // shrink-wrap the box out from under the cursor. Re-measured — via the
  // `fkMenu` dependency — on every open, since a different cell's FK list is
  // a different width.
  const [fkMenuWidth, setFkMenuWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    setFkMenuWidth(fkMenu ? fkMenuRef.current?.offsetWidth ?? null : null);
  }, [fkMenu]);
  useEffect(() => {
    if (!fkMenu) return;
    const close = () => setFkMenu(null);
    // The menu scrolls internally when it has more entries than fit, so a
    // scroll that started *inside* it must not dismiss it — only one that
    // moves the grid out from under it should.
    const onScrollAnywhere = (e: Event) => {
      if (fkMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScrollAnywhere, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", onScrollAnywhere, true);
      window.removeEventListener("resize", close);
    };
  }, [fkMenu]);

  // Keyboard copy/paste. With a whole row selected (gutter), Cmd/Ctrl+C copies
  // the row and Cmd/Ctrl+V pastes it over the selected row; with a single cell
  // selected, they operate on that cell. NULLs survive via the in-app
  // clipboards. Skipped while a cell's edit input is focused so native
  // copy/paste works there.
  useEffect(() => {
    if (!selected && rowSel.length === 0) return;
    const effectiveValue = (r: number, col: number): string | null => {
      const draftEdit = tab.pendingEdits?.[r]?.[col];
      return draftEdit !== undefined ? draftEdit : result.rows[r]?.[col] ?? null;
    };
    const width = result.columns.length;

    const rowValues = (sel: RowSelection): Array<string | null> =>
      sel.kind === "new"
        ? (tab.newRows?.[sel.index] ?? Array<string | null>(width).fill(null)).slice()
        : Array.from({ length: width }, (_, ci) => effectiveValue(sel.index, ci));

    const copyRows = (sels: RowSelection[]) => {
      const rows = sels.map(rowValues);
      rowClipboard = rows;
      // Columns joined by the configured delimiter, rows by newline — pastes
      // cleanly into spreadsheets too.
      const text = rows
        .map((r) => r.map((v) => v ?? "").join(rowCopyDelimiter))
        .join("\n");
      void copyToClipboard(text).then(showCopyStatus);
    };

    const pasteRows = (sels: RowSelection[]) => {
      if (!rowClipboard || rowClipboard.length === 0) return;
      const clip = rowClipboard;
      const target = sels.length === 1 ? sels[0] : null;
      // Paste every column verbatim, including the primary key. Conflicts (e.g.
      // duplicate key) surface on save with the reason.
      if (clip.length === 1 && target) {
        const values = clip[0];
        if (target.kind === "new") {
          for (let ci = 0; ci < width; ci++) {
            setNewCellEdit(tab.id, target.index, ci, values[ci] ?? null);
          }
        } else {
          if (!editable) return;
          overwriteRow(tab.id, target.index, values, result.columns.map((_, ci) => ci));
        }
        return;
      }
      // Multiple copied rows (or no single-row target): append them as new draft
      // rows — the "duplicate these rows" flow.
      addRows(tab.id, clip);
    };

    const onKey = (e: KeyboardEvent) => {
      // Skip while any real text-entry surface has focus — a plain
      // `<input>`/`<textarea>` (e.g. Find, the AI chat box), or a
      // contenteditable one. The table-browser filter bar in particular is a
      // CodeMirror editor, whose focused element is a `contenteditable` div
      // rather than an `HTMLInputElement`: without the `isContentEditable`
      // check here, clicking into it and pasting was silently hijacked by
      // this grid's own cell-paste handling below instead of reaching the
      // filter bar.
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        // Deselect rather than letting Escape fall through to whatever else
        // it's bound to elsewhere (e.g. the tab-level shortcut) — with a
        // cell or row focused, Escape's job is just to back out of that.
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const isCopy = e.key === "c" || e.key === "C";
      const isPaste = e.key === "v" || e.key === "V";
      if (!isCopy && !isPaste) return;

      // Whole-row selection takes precedence over a lingering cell selection.
      if (rowSel.length > 0) {
        // preventDefault so the browser's own ⌘C doesn't fire a second copy
        // event that would overwrite the clipboard with an empty selection.
        e.preventDefault();
        if (isCopy) copyRows(rowSel);
        else pasteRows(rowSel);
        return;
      }
      if (!selected) return;

      if (isCopy) {
        // preventDefault so the browser's own ⌘C doesn't fire a second copy
        // event that would overwrite what we just wrote.
        e.preventDefault();
        const value = effectiveValue(selected.r, selected.col);
        const text = value ?? "";
        cellClipboard = { text, value };
        void copyToClipboard(text).then(showCopyStatus);
      } else {
        if (!editable) return;
        const { r, col } = selected;
        e.preventDefault();
        readClipboard()
          .then((text) => {
            const value =
              cellClipboard && cellClipboard.text === text ? cellClipboard.value : text;
            setCellEdit(tab.id, r, col, value);
          })
          .catch(() => {
            // Backend clipboard read unavailable — fall back to whatever we
            // last copied in-app.
            if (cellClipboard) setCellEdit(tab.id, r, col, cellClipboard.value);
          });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selected,
    rowSel,
    result,
    tab.pendingEdits,
    tab.newRows,
    tab.id,
    editable,
    pkColIndices,
    setCellEdit,
    setNewCellEdit,
    overwriteRow,
    addRows,
    showCopyStatus,
    rowCopyDelimiter,
    clearSelection,
  ]);

  // Column geometry in display order: `starts[pos]` is the x offset of the
  // column at display position `pos` (measured from the first data column,
  // i.e. after the gutter) and `starts[n]` is the total data width. Drives
  // both the grid templates and the column-window math below.
  const colGeom = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const i of order) {
      starts.push(acc);
      acc += widths[i];
    }
    starts.push(acc);
    return { starts, total: acc };
  }, [order, widths]);

  const dragWidth = drag ? widths[order[drag.fromPos]] : 0;

  // --- Virtualization -------------------------------------------------------
  // A full page is `PAGE_SIZE` (500) rows; on a wide table that's tens of
  // thousands of grid cells in the DOM at once, which makes *the whole app*
  // sluggish (hover, typing, clicking) because every style recalc/layout the
  // browser does has to walk them all — memoizing React's own re-renders
  // doesn't help, since the cost is the browser's, not React's.
  //
  // So the grid renders a window on *both* axes. Rows alone weren't enough:
  // a 100-column table still built every column of every rendered row, which
  // is ~8x more cells than are actually on screen and was the bulk of the
  // per-scroll cost. Windowing columns too brings a 100-column table down to
  // roughly what a 12-column one costs today.
  //
  // Fixed-geometry math: `box-sizing: border-box` is global and a
  // non-wrapping row is exactly `--h-grid-row` (= the `tableRowHeight`
  // setting) tall, while column widths are explicit pixels in `widths`. Both
  // stop being true when "wrap long text" is on — rows grow to fit, and a
  // row's height then depends on columns scrolled off to the side — so
  // neither axis is windowed in that mode.
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Bumped by the ResizeObserver purely to re-trigger the window computation;
  // the sizes themselves are read live off the DOM, never from state.
  const [resizeTick, setResizeTick] = useState(0);
  // Trust the setting for layout math, but correct from the DOM once painted
  // (guards against theme/font tweaks changing the effective row box).
  const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
  const rowH = measuredRowH ?? tableRowHeight;

  const totalRows = sortedRowIndices.length;
  const totalCols = order.length;
  const virtualizeRows = !tableWrapText && totalRows > VIRTUALIZE_MIN_ROWS && rowH > 0;
  const virtualizeCols = !tableWrapText && totalCols > VIRTUALIZE_MIN_COLS;

  const [win, setWin] = useState<Win>({
    startIdx: 0,
    endIdx: 0,
    startCol: 0,
    endCol: 0,
  });

  /** Pixels the scroller moved in the last sampled frame, signed: positive
   *  is downward. Drives the leading-edge overscan in `computeWin`. A ref,
   *  not state — it changes every frame during a fling and must never itself
   *  cause a render. */
  const velocityRef = useRef(0);
  const lastTopRef = useRef(0);
  const settleRef = useRef<number | null>(null);

  /** The window implied by the scroller's *current* geometry, read straight
   *  off the DOM so it's never a state-update behind the real scroll offset. */
  const computeWin = useCallback((): Win => {
    const el = scrollRef.current;
    // Before the first layout (or while the pane is hidden and layout reports
    // 0) fall back to a generous viewport rather than rendering almost
    // nothing, so the grid never paints blank.
    const vh = el && el.clientHeight > 0 ? el.clientHeight : 900;
    const vw = el && el.clientWidth > 0 ? el.clientWidth : 1400;
    const st = el?.scrollTop ?? 0;
    const sl = el?.scrollLeft ?? 0;
    const hh = headRef.current?.offsetHeight ?? HEAD_H;

    let startIdx = 0;
    let endIdx = totalRows;
    if (virtualizeRows) {
      // Bias the buffer toward where the scroll is heading. Standing still,
      // both sides are just VIRTUALIZE_OVERSCAN; mid-fling, the leading edge
      // stretches to cover the ground about to be crossed while the trailing
      // edge stays small, so the window moves rather than merely growing.
      const lead = leadRowsFor(velocityRef.current, rowH);
      const down = velocityRef.current > 0;
      const aheadRows = VIRTUALIZE_OVERSCAN + lead;
      const first =
        Math.floor((st - hh) / rowH) - (down ? VIRTUALIZE_OVERSCAN : aheadRows);
      const last =
        Math.ceil((st - hh + vh) / rowH) + (down ? aheadRows : VIRTUALIZE_OVERSCAN);
      startIdx = clamp(snapDown(first, ROW_BLOCK), 0, totalRows);
      endIdx = clamp(snapUp(last, ROW_BLOCK), 0, totalRows);
    }

    let startCol = 0;
    let endCol = totalCols;
    if (virtualizeCols) {
      // The gutter is sticky over the left edge, so the first genuinely
      // visible data pixel is `scrollLeft`, and the last is one viewport
      // minus the gutter it hides behind.
      const first = colAt(colGeom.starts, sl) - COL_OVERSCAN;
      const last = colAt(colGeom.starts, sl + vw - GUTTER_W) + 1 + COL_OVERSCAN;
      startCol = clamp(snapDown(first, COL_BLOCK), 0, totalCols);
      endCol = clamp(snapUp(last, COL_BLOCK), 0, totalCols);
    }
    return { startIdx, endIdx, startCol, endCol };
  }, [virtualizeRows, virtualizeCols, rowH, totalRows, totalCols, colGeom]);

  const syncWin = useCallback(() => {
    setWin((prev) => {
      const next = computeWin();
      return sameWin(prev, next) ? prev : next;
    });
  }, [computeWin]);

  // Recompute before paint whenever a geometry input changes — mount, a new
  // result, the row-height/wrap settings, a column resize or reorder, a pane
  // resize. `useLayoutEffect` (not `useEffect`) so the corrected window is in
  // the DOM for the same frame; otherwise mount would paint an empty grid.
  useLayoutEffect(syncWin, [syncWin, resizeTick]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(el);
    if (headRef.current) ro.observe(headRef.current);
    return () => ro.disconnect();
  }, []);

  // Re-measure a real row's height whenever the geometry inputs change.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(".grid__row");
    if (el) {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setMeasuredRowH(h);
    }
  }, [tableRowHeight, tableWrapText, result]);

  // Scrolling is compositor-driven: by the time this fires the browser has
  // already moved the content, so the work here must be as small as possible
  // and must not happen more than once per frame. Coalescing into a single
  // rAF collapses the burst of scroll events a fling produces into one
  // window computation, and `sameWin` then drops even that unless the window
  // actually moved a whole `ROW_BLOCK`/`COL_BLOCK` — so a steady scroll
  // re-renders roughly once per 8 rows instead of once per event.
  const rafRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // Distance covered since the last sampled frame, which is what
      // `computeWin` extends the leading edge by. Sampled here rather than in
      // `computeWin` because that also runs from layout effects, where no
      // time has passed and the reading would be meaningless.
      const top = scrollRef.current?.scrollTop ?? 0;
      velocityRef.current = top - lastTopRef.current;
      lastTopRef.current = top;
      syncWin();
      // Once the fling stops, no further scroll events arrive to reset this,
      // so the window would stay stretched. Settle it on the next frame.
      if (velocityRef.current !== 0) {
        settleRef.current ??= requestAnimationFrame(() => {
          settleRef.current = null;
          const now = scrollRef.current?.scrollTop ?? 0;
          if (now === lastTopRef.current) {
            velocityRef.current = 0;
            syncWin();
          }
        });
      }
    });
  }, [syncWin]);
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (settleRef.current != null) cancelAnimationFrame(settleRef.current);
    },
    [],
  );

  const { startIdx, endIdx, startCol, endCol } = win;

  /** Bring a cell into view on both axes even if it isn't currently rendered
   *  (windowing means `querySelector` alone can't find it). Recomputes the
   *  window synchronously afterwards rather than waiting for the resulting
   *  `scroll` event, so the target exists on the very next paint — the event
   *  round-trip would otherwise leave a frame where a follow-up
   *  `scrollIntoView` has nothing to find. */
  const scrollCellIntoView = useCallback(
    (rowPos: number, colPos: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const hh = headRef.current?.offsetHeight ?? HEAD_H;
      if (virtualizeRows && rowPos >= 0) {
        const top = hh + rowPos * rowH;
        if (top < el.scrollTop + hh || top + rowH > el.scrollTop + el.clientHeight) {
          el.scrollTop = Math.max(0, top - el.clientHeight / 2);
        }
      }
      if (virtualizeCols && colPos >= 0) {
        const left = colGeom.starts[colPos];
        const right = colGeom.starts[colPos + 1];
        if (left < el.scrollLeft || right + GUTTER_W > el.scrollLeft + el.clientWidth) {
          el.scrollLeft = Math.max(0, left - el.clientWidth / 2);
        }
      }
      syncWin();
    },
    [virtualizeRows, virtualizeCols, rowH, colGeom, syncWin],
  );

  /** Scroll a column into view (horizontally only — `rowPos: -1` skips the
   *  vertical adjustment `scrollCellIntoView` would otherwise do) and
   *  highlight it via the same crosshair `selected` state a clicked cell
   *  gets, without changing which row is selected. */
  const jumpToColumnIndex = useCallback(
    (colIndex: number) => {
      scrollCellIntoView(-1, order.indexOf(colIndex));
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-header="${colIndex}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
      setSelected((s) => ({ r: s?.r ?? 0, col: colIndex }));
      setColJumpOpen(false);
      setColJumpQuery("");
    },
    [order, scrollCellIntoView],
  );

  const colJumpMatches = useMemo(() => {
    const q = colJumpQuery.trim();
    if (!q) return result.columns.map((c, i) => ({ index: i, name: c.name }));
    const scored: Array<{ index: number; name: string; score: number }> = [];
    result.columns.forEach((c, i) => {
      const m = bestMatch(q, [c.name]);
      if (m) scored.push({ index: i, name: c.name, score: m.score });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }, [result.columns, colJumpQuery]);

  useEffect(() => {
    setColJumpSelected(0);
    colJumpMouseArmedRef.current = false;
  }, [colJumpQuery]);

  // The columns actually rendered in each row. Memoized because it's a prop
  // on every `GridRow`, whose `memo()` needs a stable reference.
  const visibleOrder = useMemo(
    () =>
      startCol === 0 && endCol === totalCols ? order : order.slice(startCol, endCol),
    [order, startCol, endCol, totalCols],
  );

  // The header renders every column unwindowed: it's one element per column
  // (nothing, even at 100+), and it keeps the drag-to-reorder transforms —
  // which are indexed by absolute display position — working untouched.
  const headStyle = useMemo(
    () => ({
      gridTemplateColumns: `${GUTTER_W}px ` + order.map((i) => `${widths[i]}px`).join(" "),
      width: GUTTER_W + colGeom.total,
    }),
    [order, widths, colGeom],
  );

  // Rows use the windowed template, with a track at each end standing in for
  // the columns scrolled off to the left and right. That lands the rendered
  // cells at exactly the same x as the header's without any per-cell grid
  // placement, and keeps the row's total width driving the h-scrollbar.
  // Memoized for the same `memo()` reason as `visibleOrder`.
  const rowStyle = useMemo(() => {
    const left = colGeom.starts[startCol];
    const right = colGeom.total - colGeom.starts[endCol];
    const mid = visibleOrder.map((i) => `${widths[i]}px`).join(" ");
    return {
      gridTemplateColumns: `${GUTTER_W}px ${left}px ${mid} ${right}px`,
      width: GUTTER_W + colGeom.total,
    };
  }, [colGeom, startCol, endCol, visibleOrder, widths]);

  // Virtualized rows come out of flow, so the body reserves the full scroll
  // height itself — just the real rows; the bottom breathing room is
  // `.grid__scroll`'s own padding now, so it trails draft new rows too. See
  // `.grid__body--virtual` in workspace.css for why this beats the spacer
  // divs this replaced.
  const bodyStyle = useMemo(
    () => (virtualizeRows ? { height: totalRows * rowH } : undefined),
    [virtualizeRows, totalRows, rowH],
  );

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

  /** Double-clicking a resize handle fits that column to its content — the
   *  same measurement the initial layout uses, but on demand and with a
   *  higher ceiling, so a column that was capped (or narrowed by hand, or
   *  laid out before the font size changed) can be corrected in one gesture
   *  instead of dragged. */
  const autoFitColumn = (colIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = [...widths];
    next[colIndex] = measuredWidths(result, numericCols, MAX_AUTOFIT_WIDTH)[colIndex];
    setWidths(next);
    persistLayout(signature, result.columns, order, next);
  };

  // Cycle a column's sort: default -> ascending -> descending -> default.
  // `table` tabs push this down to the backend as a real `ORDER BY` (see the
  // `sort` derivation above); everything else just re-sorts the already-
  // loaded rows in place.
  const cycleSort = (col: number) => {
    if (isTable) {
      const name = result.columns[col]?.name;
      if (!name) return;
      if (tab.sortColumn !== name) void setTableSort(tab.id, name, false);
      else if (!tab.sortDesc) void setTableSort(tab.id, name, true);
      else void setTableSort(tab.id, null, false);
      return;
    }
    setLocalSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  };

  // A header press is either a click (sort) or a drag (reorder) — decided by
  // whether the pointer moves past a small threshold. Anywhere in the header
  // cell works; the drag animates the header row and reorders data on drop.
  const DRAG_THRESHOLD = 5;
  // How far into a neighboring column the dragged column's leading edge must
  // travel before it swaps places, as a fraction of the neighbor's width.
  // Comparing edges (rather than the dragged column's own center) means its
  // own width no longer adds to the distance required — lower this to make
  // reordering trigger sooner.
  const SWAP_TRIGGER = 0.5;
  const onHeaderMouseDown = (pos: number, colIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let starts: number[] = [];
    let dispWidths: number[] = [];

    const beginDrag = () => {
      dispWidths = order.map((i) => widths[i]);
      starts = [];
      let acc = 0;
      for (const w of dispWidths) {
        starts.push(acc);
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
      const draggedWidth = dispWidths[pos];
      let target = pos;
      // Dragging right: swap once the dragged column's right edge reaches
      // partway into the next column.
      while (target < dispWidths.length - 1) {
        const rightEdge = starts[pos] + draggedWidth + dx;
        const threshold = starts[target + 1] + dispWidths[target + 1] * SWAP_TRIGGER;
        if (rightEdge <= threshold) break;
        target += 1;
      }
      // Dragging left: swap once the dragged column's left edge reaches
      // partway into the previous column.
      while (target > 0) {
        const leftEdge = starts[pos] + dx;
        const threshold = starts[target - 1] + dispWidths[target - 1] * (1 - SWAP_TRIGGER);
        if (leftEdge >= threshold) break;
        target -= 1;
      }
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

  // Find-in-results matches: every visible cell (existing rows only — draft
  // rows are few and already visible unscrolled) whose value contains the
  // query, case-insensitively, in display order (row then column).
  const cellValue = useCallback(
    (r: number, col: number): string | null => {
      const draftEdit = tab.pendingEdits?.[r]?.[col];
      return draftEdit !== undefined ? draftEdit : result.rows[r]?.[col] ?? null;
    },
    [tab.pendingEdits, result],
  );

  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const found: Array<{ r: number; col: number }> = [];
    for (const r of sortedRowIndices) {
      for (const col of order) {
        const v = cellValue(r, col);
        if (v != null && v.toLowerCase().includes(q)) found.push({ r, col });
      }
    }
    return found;
  }, [findQuery, sortedRowIndices, order, cellValue]);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery]);

  useEffect(() => {
    if (findMatches.length === 0) return;
    const m = findMatches[Math.min(findIndex, findMatches.length - 1)];
    if (!m) return;
    setSelected({ r: m.r, col: m.col });
    // By arithmetic on both axes: the match may be outside the rendered
    // window on either one — with columns windowed too, an off-screen column
    // has no element to `scrollIntoView` any more than an off-screen row
    // does. This brings it into the window; the follow-up frame (once it has
    // rendered) only nudges it the last few pixels.
    scrollCellIntoView(sortedRowIndices.indexOf(m.r), order.indexOf(m.col));
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`[data-cell="${m.r}-${m.col}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findIndex, findMatches]);

  // Memoized so its identity only changes when `findMatches` actually does —
  // the big keydown-listener effect below calls this rather than reading
  // `findMatches` itself, and needs a stable reference to depend on instead
  // of re-subscribing its global `window` listener on every render.
  const gotoFindMatch = useCallback(
    (delta: number) => {
      if (findMatches.length === 0) return;
      setFindIndex(
        (i) => ((i + delta) % findMatches.length + findMatches.length) % findMatches.length,
      );
    },
    [findMatches],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen || e.defaultPrevented || e.repeat) return;
      if (matchesKeybinding(e, findBinding)) {
        e.preventDefault();
        setColJumpOpen(false);
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
        return;
      }
      if (matchesKeybinding(e, jumpColumnBinding)) {
        e.preventDefault();
        setFindOpen(false);
        setColJumpOpen(true);
        setColJumpQuery("");
        setColJumpSelected(0);
        colJumpMouseArmedRef.current = false;
        requestAnimationFrame(() => colJumpInputRef.current?.focus());
        return;
      }
      // Fallback navigation for the column-jump popup: the input's own
      // onKeyDown normally handles these, but this window-level listener
      // catches them too in case focus didn't land on the input (e.g. it
      // opened while the SQL editor still held focus), so arrow/enter
      // navigation always works once the popup is open.
      if (colJumpOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setColJumpOpen(false);
          setColJumpQuery("");
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const max = Math.min(colJumpMatches.length, 20) - 1;
          setColJumpSelected((i) => Math.min(i + 1, max));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setColJumpSelected((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const top = colJumpMatches[colJumpSelected];
          if (top) jumpToColumnIndex(top.index);
          return;
        }
        return;
      }
      if (!findOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setFindOpen(false);
        setFindQuery("");
        return;
      }
      if (e.key === "Enter" && document.activeElement === findInputRef.current) {
        e.preventDefault();
        gotoFindMatch(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    findOpen,
    gotoFindMatch,
    findBinding,
    jumpColumnBinding,
    settingsOpen,
    colJumpOpen,
    colJumpMatches,
    colJumpSelected,
    jumpToColumnIndex,
  ]);

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

  // Pagination: a full page implies there may be more rows. Table tabs always
  // page; a query tab pages whenever the driver was able to bound its
  // statement (`paged`) — one carrying its own LIMIT is shown whole instead.
  const page = tab.page ?? 0;
  const rowCount = result.rows.length;
  const showPager = isTable || result.paged;
  const canNext = rowCount === PAGE_SIZE;
  const pagerLabel =
    rowCount === 0
      ? `Page ${page + 1} · no rows`
      : `Rows ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rowCount}`;

  // A table tab re-queries its own generated SELECT; a query tab re-runs the
  // user's statement at the new offset.
  const goToPage = (next: number) =>
    isTable ? setTablePage(tab.id, next) : setQueryPage(tab.id, next);

  const handleAddRow = () => {
    const index = tab.newRows?.length ?? 0;
    addRow(tab.id);
    selectRow({ kind: "new", index });
    // New rows always append after everything else (real rows, then earlier
    // drafts), so the bottom of the scroll container is always exactly where
    // the one just added lands — no per-row position math needed, unlike
    // `scrollCellIntoView` for the (virtualized, windowed) real rows above.
    // One frame out so this runs after the new row has actually rendered.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  };
  const handleRemoveRow = () => {
    if (rowSel.length === 0) return;
    // Discard any selected draft rows locally (highest index first so earlier
    // ones don't shift), then delete the selected existing rows with one confirm.
    const newIdxs = rowSel
      .filter((s) => s.kind === "new")
      .map((s) => s.index)
      .sort((a, b) => b - a);
    for (const idx of newIdxs) removeNewRow(tab.id, idx);

    const existingIdxs = rowSel
      .filter((s) => s.kind === "existing")
      .map((s) => s.index);
    if (existingIdxs.length > 0) void deleteExistingRows(tab.id, existingIdxs);

    setRowSel([]);
    rowAnchorRef.current = null;
  };

  const importInputRef = useRef<HTMLInputElement>(null);

  // Parse a CSV file and append its rows as draft rows (the same "new row"
  // flow as Add row / paste), matching header names to this table's columns
  // case-insensitively. Unmatched CSV columns are ignored; unmatched table
  // columns and blank CSV cells are left to the column's default, same as an
  // unedited "Add row" cell. Nothing is inserted until the user hits Update.
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file again later
    if (!file) return;

    const fail = (message: string) =>
      setUpdateError(tab.id, {
        message,
        code: null,
        hint: null,
        position: null,
        kind: "internal",
      });

    const text = await file.text();
    const rows = parseCsv(text, csvDelimiter);
    if (rows.length === 0) {
      fail("CSV import failed: the file is empty.");
      return;
    }
    const [header, ...dataRows] = rows;
    if (dataRows.length === 0) {
      fail("CSV import failed: the file has a header row but no data rows.");
      return;
    }

    const colIndexByName = new Map(
      result.columns.map((c, i) => [c.name.toLowerCase(), i]),
    );
    const targetForCsvCol = header.map(
      (h) => colIndexByName.get(h.trim().toLowerCase()) ?? null,
    );
    if (targetForCsvCol.every((i) => i === null)) {
      fail(
        `CSV import failed: no column in the file matched this table's columns ` +
          `(expected one of: ${result.columns.map((c) => c.name).join(", ")}).`,
      );
      return;
    }

    const width = result.columns.length;
    const draftRows = dataRows.map((csvRow) => {
      const draft = Array<string | null>(width).fill(null);
      csvRow.forEach((value, ci) => {
        const targetIdx = targetForCsvCol[ci];
        if (targetIdx == null) return; // CSV column didn't match any table column
        if (value !== "") draft[targetIdx] = value; // blank cell -> leave to default
      });
      return draft;
    });

    addRows(tab.id, draftRows);
  };

  return (
    <>
    <div className="grid">
      {findOpen && (
        <div className="grid-find">
          <input
            ref={findInputRef}
            className="grid-find__input"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in results…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span className="grid-find__count mono">
            {findQuery.trim() === ""
              ? ""
              : findMatches.length === 0
                ? "0/0"
                : `${findIndex + 1}/${findMatches.length}`}
          </span>
          <button
            className="grid-find__nav"
            onClick={() => gotoFindMatch(-1)}
            disabled={findMatches.length === 0}
            title="Previous match (Shift+Enter)"
          >
            ‹
          </button>
          <button
            className="grid-find__nav"
            onClick={() => gotoFindMatch(1)}
            disabled={findMatches.length === 0}
            title="Next match (Enter)"
          >
            ›
          </button>
          <button
            className="grid-find__close"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
            }}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}
      {colJumpOpen && (
        <div
          className="colgo-overlay"
          onClick={() => {
            setColJumpOpen(false);
            setColJumpQuery("");
          }}
        >
          <div className="grid-colgo" onClick={(e) => e.stopPropagation()}>
            <div className="grid-colgo__bar">
              <input
                ref={colJumpInputRef}
                className="grid-colgo__input"
                value={colJumpQuery}
                onChange={(e) => setColJumpQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setColJumpOpen(false);
                    setColJumpQuery("");
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.stopPropagation();
                    const max = Math.min(colJumpMatches.length, 20) - 1;
                    setColJumpSelected((i) => Math.min(i + 1, max));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    e.stopPropagation();
                    setColJumpSelected((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const top = colJumpMatches[colJumpSelected];
                    if (top) jumpToColumnIndex(top.index);
                  }
                }}
                placeholder="Jump to column…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                className="grid-find__close"
                onClick={() => {
                  setColJumpOpen(false);
                  setColJumpQuery("");
                }}
                title="Close (Esc)"
              >
                ×
              </button>
            </div>
            <div
              className="grid-colgo__list"
              onMouseMove={() => {
                colJumpMouseArmedRef.current = true;
              }}
            >
              {colJumpMatches.length === 0 ? (
                <div className="grid-colgo__empty">No matching columns.</div>
              ) : (
                colJumpMatches.slice(0, 20).map((m, i) => (
                  <div
                    key={m.index}
                    className={
                      "grid-colgo__item" + (i === colJumpSelected ? " grid-colgo__item--active" : "")
                    }
                    onMouseEnter={() => {
                      if (colJumpMouseArmedRef.current) setColJumpSelected(i);
                    }}
                    onClick={() => jumpToColumnIndex(m.index)}
                  >
                    {m.name}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      <div
        className="grid__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        data-wrap={tableWrapText ? "on" : "off"}
      >
        <div className="grid__head" style={headStyle} ref={headRef}>
          <div
            className="grid__gutter grid__gutter--head"
            onClick={clearSelection}
            title="Click to deselect"
          />
          {order.map((colIndex, pos) => (
            <div
              key={colIndex}
              data-header={colIndex}
              className={
                "grid__hcell" +
                (numericCols[colIndex] ? " grid__cell--num" : "") +
                (drag ? " grid__hcell--sliding" : "") +
                (drag && drag.fromPos === pos ? " grid__hcell--dragging" : "") +
                (selected?.col === colIndex ? " grid__hcell--active" : "")
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
                onDoubleClick={autoFitColumn(colIndex)}
                title="Drag to resize · double-click to fit contents"
              />
            </div>
          ))}
        </div>
        {result.rows.length === 0 && (
          <div className="results__note results__note--sub">No rows returned.</div>
        )}
        <div
          className={"grid__body" + (virtualizeRows ? " grid__body--virtual" : "")}
          style={bodyStyle}
        >
        {(() => {
          // Hoisted out of the row loop — the same for every row, just
          // compared against each row's own `r` below.
          const activeMatch = findMatches[findIndex];
          const selectedColGlobal = selected?.col ?? null;
          return sortedRowIndices.slice(startIdx, endIdx).map((r, i) => {
            const displayPos = startIdx + i;
            return (
            <GridRow
              key={r}
              r={r}
              displayPos={displayPos}
              offsetY={virtualizeRows ? displayPos * rowH : null}
              row={result.rows[r]}
              rowEdits={tab.pendingEdits?.[r]}
              rowStyle={rowStyle}
              order={visibleOrder}
              numericCols={numericCols}
              booleanCols={booleanCols}
              navByColumn={navByColumn}
              pkColIndices={pkColIndices}
              nullText={nullText}
              editable={editable}
              isRowActive={selected?.r === r}
              selectedCol={selectedColGlobal}
              isRowGutterSelected={isRowSelected("existing", r)}
              editingCell={
                !editing?.isNew && editing?.r === r
                  ? { col: editing.col, draft: editing.draft }
                  : null
              }
              findOpen={findOpen}
              findQuery={findQuery}
              activeMatchCol={activeMatch?.r === r ? activeMatch.col : null}
              onGutterClick={onExistingGutterClick}
              onCellClick={onCellClick}
              onCellDoubleClick={onCellDoubleClick}
              onCellContextMenu={onCellContextMenu}
              onEditDraftChange={onEditDraftChange}
              onEditCommit={onEditCommit}
              onEditCancel={onEditCancel}
            />
            );
          });
        })()}
        </div>
        {isTable &&
          (tab.newRows ?? []).map((draft, ni) => (
            <GridNewRow
              key={`new-${ni}`}
              ni={ni}
              draft={draft}
              rowStyle={rowStyle}
              order={visibleOrder}
              numericCols={numericCols}
              isRowGutterSelected={isRowSelected("new", ni)}
              editingCell={
                editing?.isNew && editing.r === ni
                  ? { col: editing.col, draft: editing.draft }
                  : null
              }
              onGutterClick={onNewGutterClick}
              onNewCellClick={onNewCellClick}
              onEditDraftChange={onEditDraftChange}
              onEditCommit={onEditCommit}
              onEditCancel={onEditCancel}
            />
          ))}
      </div>

      {fkMenu &&
        (() => {
          const col = fkMenu.col;
          const nav = navByColumn?.[col];
          const original = result.rows[fkMenu.r]?.[col] ?? null;
          const draftEdit = tab.pendingEdits?.[fkMenu.r]?.[col];
          const isDirty = draftEdit !== undefined;
          const value = isDirty ? draftEdit : original;
          const hasFk =
            !!nav &&
            value !== null &&
            (nav.references.length > 0 || nav.referencedBy.length > 0);
          const canSetNull =
            editable &&
            !pkColIndices.has(col) &&
            nullableColIndices.has(col) &&
            value !== null;
          // "Expand cell" always applies, so — unlike before this existed —
          // there's no longer a case where right-clicking a plain cell has
          // nothing to show.

          const literal = (value ?? "").replace(/'/g, "''");
          const openRef = (ref: ForeignKeyRef) => {
            setFkMenu(null);
            // Double-quote the column name: it's machine-generated from the
            // schema, not user-typed, and mixed-case identifiers (e.g. from a
            // TypeORM/Prisma-created table) fold to lowercase and stop
            // matching if left bare — Postgres then reports the column as
            // not existing.
            const col = ref.column.replace(/"/g, '""');
            void openTableWithFilter(
              ref.schema,
              ref.table,
              `"${col}" = '${literal}'`,
            );
          };
          const item = (ref: ForeignKeyRef, key: string) => (
            <button
              key={key}
              className="context-menu__item context-menu__item--fk"
              title={`${ref.schema}.${ref.table}.${ref.column}`}
              onClick={() => openRef(ref)}
            >
              <span className="context-menu__fk-name">{ref.table}</span>
              <span className="context-menu__sub mono">
                {ref.schema}.{ref.column}
              </span>
            </button>
          );
          // Shown whenever there's more than one entry to filter — a fixed
          // "enough to bother" cutoff meant well but just made it unclear
          // when typing would actually do anything.
          const totalRefs = hasFk ? nav!.references.length + nav!.referencedBy.length : 0;
          const showFkSearch = totalRefs > 1;
          const q = fkQuery.trim().toLowerCase();
          const matchesQuery = (ref: ForeignKeyRef) =>
            !q || ref.table.toLowerCase().includes(q) || ref.schema.toLowerCase().includes(q);
          const filteredReferences = hasFk ? nav!.references.filter(matchesQuery) : [];
          const filteredReferencedBy = hasFk ? nav!.referencedBy.filter(matchesQuery) : [];
          const fkNoMatches =
            showFkSearch &&
            q.length > 0 &&
            filteredReferences.length === 0 &&
            filteredReferencedBy.length === 0;
          return (
            <div
              ref={fkMenuRef}
              className={"context-menu" + (hasFk ? " context-menu--fk" : "")}
              style={{
                ...fkMenuStyle(fkMenu.x, fkMenu.y),
                ...(fkMenuWidth ? { width: fkMenuWidth } : {}),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="context-menu__item"
                onClick={() => {
                  setFkMenu(null);
                  setExpandedCell({ value, columnName: result.columns[col].name });
                }}
              >
                Expand cell
              </button>
              {(hasFk || canSetNull || isDirty) && <div className="context-menu__sep" />}
              {hasFk && showFkSearch && (
                <div className="context-menu__search">
                  <input
                    ref={fkQueryRef}
                    className="context-menu__search-input"
                    value={fkQuery}
                    onChange={(e) => setFkQuery(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setFkMenu(null);
                      }
                    }}
                    placeholder="Filter tables…"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoFocus
                  />
                </div>
              )}
              {hasFk && filteredReferences.length > 0 && (
                <>
                  <div className="context-menu__label">Jump to referenced row</div>
                  {filteredReferences.map((ref, i) => item(ref, `out-${i}`))}
                </>
              )}
              {hasFk && filteredReferencedBy.length > 0 && (
                <>
                  <div className="context-menu__label">Rows referencing this</div>
                  {filteredReferencedBy.map((ref, i) => item(ref, `in-${i}`))}
                </>
              )}
              {fkNoMatches && (
                <div className="context-menu__empty">No matching tables.</div>
              )}
              {canSetNull && (
                <>
                  {hasFk && <div className="context-menu__sep" />}
                  <button
                    className="context-menu__item"
                    onClick={() => {
                      setFkMenu(null);
                      setCellEdit(tab.id, fkMenu.r, col, null);
                    }}
                  >
                    Set to <span className="mono">NULL</span>
                  </button>
                </>
              )}
              {isDirty && (
                <>
                  {(hasFk || canSetNull) && <div className="context-menu__sep" />}
                  <button
                    className="context-menu__item"
                    onClick={() => {
                      setFkMenu(null);
                      // setCellEdit already clears the pending edit for a
                      // cell whose new value equals the original.
                      setCellEdit(tab.id, fkMenu.r, col, original);
                    }}
                  >
                    Revert to original
                  </button>
                </>
              )}
            </div>
          );
        })()}

      {copyStatus && (
        <div
          className={
            "copy-status" + (copyStatus.ok ? "" : " copy-status--fail")
          }
        >
          <div className="copy-status__head">
            {copyStatus.ok ? "Copied ✓" : "Copy FAILED ✗"}
          </div>
          <div className="copy-status__value mono">
            {copyStatus.text === "" ? "(empty)" : copyStatus.text}
          </div>
          <div className="copy-status__methods mono">
            {`exec:${copyStatus.execOk ? "✓" : "✗"}  nav:${
              copyStatus.navOk ? "✓" : "✗"
            }  backend:${copyStatus.backendOk ? "✓" : "✗"}`}
          </div>
          {copyStatus.error && (
            <div className="copy-status__error mono">{copyStatus.error}</div>
          )}
        </div>
      )}
    </div>

    {showPager && (
      <div className="table-toolbar">
        <div className="table-toolbar__group">
          <button
            className="table-toolbar__btn"
            disabled={page === 0 || tab.running}
            onClick={() => void goToPage(page - 1)}
            title="Previous page"
          >
            ‹ Prev
          </button>
          <span className="table-toolbar__info mono">{pagerLabel}</span>
          <button
            className="table-toolbar__btn"
            disabled={!canNext || tab.running}
            onClick={() => void goToPage(page + 1)}
            title="Next page"
          >
            Next ›
          </button>
        </div>
        {editable && (
          <div className="table-toolbar__group">
            <button
              className="table-toolbar__btn"
              onClick={handleAddRow}
              title="Add a new row (inserted on Update)"
            >
              ＋ Add row
            </button>
            <button
              className="table-toolbar__btn"
              onClick={() => importInputRef.current?.click()}
              title="Import rows from a CSV file (added as new rows, inserted on Update)"
            >
              ⇪ Import CSV
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              className="table-toolbar__file-input"
              onChange={(e) => void handleImportFile(e)}
            />
            <button
              className="table-toolbar__btn table-toolbar__btn--danger"
              disabled={rowSel.length === 0}
              onClick={handleRemoveRow}
              title={
                rowSel.length > 0
                  ? `Remove the selected row${rowSel.length > 1 ? "s" : ""}`
                  : "Select a row (click its number) to remove it"
              }
            >
              － Remove {rowSel.length > 1 ? `${rowSel.length} rows` : "row"}
            </button>
          </div>
        )}
      </div>
    )}
    {expandedCell && (
      <CellInspectorDialog cell={expandedCell} onClose={() => setExpandedCell(null)} />
    )}
    </>
  );
}

/** Read-only "view full cell value" dialog, opened from a cell's right-click
 *  menu — for a value too long to read in a 32px-tall grid cell (a long
 *  string, a JSON blob). Objects/arrays are pretty-printed; this is purely a
 *  display transform, the cell's stored value is untouched, and Copy copies
 *  exactly what's shown here (formatted, if it was reformatted). */
function CellInspectorDialog({
  cell,
  onClose,
}: {
  cell: { value: string | null; columnName: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const { text, isJson } = useMemo(() => {
    if (cell.value === null) return { text: null as string | null, isJson: false };
    try {
      const parsed: unknown = JSON.parse(cell.value);
      // Only objects/arrays are worth reformatting — a bare JSON number or
      // string ('42', '"hi"') parses fine but pretty-printing it wouldn't
      // show anything the plain value doesn't already.
      if (parsed !== null && typeof parsed === "object") {
        return { text: JSON.stringify(parsed, null, 2), isJson: true };
      }
    } catch {
      // Not JSON — falls through to the plain value below.
    }
    return { text: cell.value, isJson: false };
  }, [cell.value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    if (text === null) return;
    void copyToClipboard(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="cell-inspector"
        role="dialog"
        aria-modal="true"
        aria-label={`${cell.columnName} value`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__head">
          <span className="settings-panel__title mono">{cell.columnName}</span>
          <div className="cell-inspector__head-actions">
            {isJson && <span className="cell-inspector__badge">JSON</span>}
            <button
              className="snippet-actions__btn"
              onClick={copy}
              disabled={text === null}
              title="Copy to clipboard"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="settings-panel__close"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
        <div className="cell-inspector__body mono">
          {text === null ? <span className="cell-inspector__null">NULL</span> : text}
        </div>
      </div>
    </div>
  );
}

interface GridCellProps {
  r: number;
  colIndex: number;
  value: string | null;
  isDirty: boolean;
  /** Exact selected cell (row *and* column match). */
  isSelected: boolean;
  /** Selected cell's column, highlighted down every row (the "crosshair"
   *  design — see the `.grid__cell--col-active` comment in workspace.css).
   *  Global, not row-scoped, so it's the same value for every row's cell in
   *  that column — this is exactly why cells (not just rows) need their own
   *  `memo()`: a click changes this for every row, but only the ~2 columns
   *  (old + new selected) actually need to re-render, not all of them. */
  isColActive: boolean;
  isPk: boolean;
  isFk: boolean;
  nav: ColNav | undefined;
  numeric: boolean;
  /** True if every non-null value in this column is Postgres's canonical
   *  boolean text form (`t`/`f`) — displayed as `true`/`false` instead. */
  isBoolean: boolean;
  editable: boolean;
  nullText: string;
  isEditing: boolean;
  editDraft: string;
  findOpen: boolean;
  findQuery: string;
  isActiveFindMatch: boolean;
  onCellClick: (r: number, col: number) => void;
  onCellDoubleClick: (r: number, col: number, currentValue: string | null) => void;
  onCellContextMenu: (e: React.MouseEvent, r: number, col: number) => void;
  onEditDraftChange: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCommit: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCancel: () => void;
}

/**
 * One data cell in the results grid — the leaf `memo()` boundary that makes
 * clicking a cell cheap regardless of result-set size. See `GridRow`'s doc
 * comment for the full picture of why this needed splitting this finely.
 */
const GridCell = memo(function GridCell({
  r,
  colIndex,
  value,
  isDirty,
  isSelected,
  isColActive,
  isPk,
  isFk,
  nav,
  numeric,
  isBoolean,
  editable,
  nullText,
  isEditing,
  editDraft,
  findOpen,
  findQuery,
  isActiveFindMatch,
  onCellClick,
  onCellDoubleClick,
  onCellContextMenu,
  onEditDraftChange,
  onEditCommit,
  onEditCancel,
}: GridCellProps) {
  if (isEditing) {
    return (
      <div
        className={"grid__cell grid__cell--editing" + (numeric ? " grid__cell--num" : "")}
      >
        <input
          className="grid__cell-input mono"
          autoFocus
          value={editDraft}
          onFocus={(e) => e.target.select()}
          onChange={(e) => onEditDraftChange(r, colIndex, e.target.value)}
          onBlur={() => onEditCommit(r, colIndex, editDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEditCommit(r, colIndex, editDraft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onEditCancel();
            }
          }}
        />
      </div>
    );
  }

  // `t`/`f` is Postgres's canonical boolean text form, not something a user
  // would recognize at a glance — shown as `true`/`false` instead. Only the
  // display changes; the underlying value (what editing operates on) is
  // untouched.
  const displayValue =
    isBoolean && value === "t" ? "true" : isBoolean && value === "f" ? "false" : value;

  return (
    <div
      data-cell={`${r}-${colIndex}`}
      className={
        "grid__cell" +
        (numeric ? " grid__cell--num mono" : "") +
        (value === null ? " grid__cell--null" : "") +
        (isColActive ? " grid__cell--col-active" : "") +
        (isSelected ? " grid__cell--selected" : "") +
        (isFk ? " grid__cell--fk" : "") +
        (isDirty ? " grid__cell--dirty" : "") +
        (isPk && editable ? " grid__cell--pk" : "")
      }
      title={
        isFk
          ? fkTooltip(nav!)
          : isPk && editable
            ? "Primary key — double-click to edit (changes the row's key)"
            : displayValue ?? "NULL"
      }
      onClick={() => onCellClick(r, colIndex)}
      onDoubleClick={() => {
        if (!editable) return;
        onCellDoubleClick(r, colIndex, value);
      }}
      onContextMenu={(e) => {
        // Always shown now — "Expand cell" applies to every cell, not just
        // the ones with an FK/null/dirty action.
        e.preventDefault();
        onCellContextMenu(e, r, colIndex);
      }}
    >
      <span className="grid__cell-text">
        {displayValue === null
          ? nullText
          : findOpen && findQuery.trim()
            ? highlightMatches(displayValue, findQuery, isActiveFindMatch)
            : displayValue}
      </span>
    </div>
  );
});

interface GridRowProps {
  r: number;
  displayPos: number;
  /** Y offset within the virtualized body, or null when rows are in flow. */
  offsetY: number | null;
  row: Array<string | null>;
  rowEdits: Record<number, string | null> | undefined;
  rowStyle: React.CSSProperties;
  /** The *windowed* display order — only the columns currently on screen. */
  order: number[];
  numericCols: boolean[];
  booleanCols: boolean[];
  navByColumn: ColNav[] | null;
  pkColIndices: Set<number>;
  nullText: string;
  editable: boolean;
  isRowActive: boolean;
  selectedCol: number | null;
  isRowGutterSelected: boolean;
  editingCell: { col: number; draft: string } | null;
  findOpen: boolean;
  findQuery: string;
  activeMatchCol: number | null;
  onGutterClick: (e: React.MouseEvent, r: number) => void;
  onCellClick: (r: number, col: number) => void;
  onCellDoubleClick: (r: number, col: number, currentValue: string | null) => void;
  onCellContextMenu: (e: React.MouseEvent, r: number, col: number) => void;
  onEditDraftChange: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCommit: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCancel: () => void;
}

/**
 * One existing-row of the results grid. `memo()`-wrapped, with narrow,
 * row-scoped props instead of reading `selected`/`rowSel`/`editing`/
 * `findQuery` etc. from `ResultsGrid`'s closure — without this, *any* local
 * state change there (including just clicking a cell) re-renders and
 * reconciles every currently-loaded row (up to 500) times every column,
 * which is invisible with a handful of columns/rows but multi-second on a
 * wide, fully-paged production table. `GridRow` itself still re-executes on
 * most clicks (it needs the globally-selected column to hand to every
 * cell, for the "crosshair" column highlight — see `GridCell`), but that's
 * just cheap JS object creation; the actual expensive DOM work is gated one
 * level down, per cell, by `GridCell`'s own `memo()`.
 */
const GridRow = memo(function GridRow({
  r,
  displayPos,
  offsetY,
  row,
  rowEdits,
  rowStyle,
  order,
  numericCols,
  booleanCols,
  navByColumn,
  pkColIndices,
  nullText,
  editable,
  isRowActive,
  selectedCol,
  isRowGutterSelected,
  editingCell,
  findOpen,
  findQuery,
  activeMatchCol,
  onGutterClick,
  onCellClick,
  onCellDoubleClick,
  onCellContextMenu,
  onEditDraftChange,
  onEditCommit,
  onEditCancel,
}: GridRowProps) {
  const rowDirty = !!rowEdits && Object.keys(rowEdits).length > 0;
  // Merged here rather than by the parent so `rowStyle` stays a single shared
  // object across every row (the `memo()` above compares it by reference).
  const style = useMemo(
    () =>
      offsetY == null
        ? rowStyle
        : { ...rowStyle, transform: `translateY(${offsetY}px)` },
    [rowStyle, offsetY],
  );
  return (
    <div
      className={
        "grid__row" +
        (displayPos % 2 === 1 ? " grid__row--zebra" : "") +
        (isRowActive ? " grid__row--active" : "") +
        (isRowGutterSelected ? " grid__row--rowsel" : "") +
        (rowDirty ? " grid__row--dirty" : "")
      }
      style={style}
    >
      <div
        className="grid__gutter"
        title="Click to select the row · Shift-click for a range · ⌘/Ctrl-click to add · ⌘C copies, ⌘V pastes/duplicates"
        onClick={(e) => onGutterClick(e, r)}
      >
        {displayPos + 1}
      </div>
      {/* Stand-ins for the columns windowed off each side — see `rowStyle`. */}
      <div className="grid__spacer" aria-hidden />
      {order.map((colIndex) => {
        const original = row[colIndex];
        const draftEdit = rowEdits?.[colIndex];
        const value = draftEdit !== undefined ? draftEdit : original;
        const isDirty = draftEdit !== undefined;
        const isPk = pkColIndices.has(colIndex);
        const nav = navByColumn?.[colIndex];
        const isFk =
          !!nav &&
          original !== null &&
          (nav.references.length > 0 || nav.referencedBy.length > 0);
        // Exclude `isNew` edits: a draft row shares the same numeric index
        // as an existing row, so without this an existing row would also
        // render an edit input for a draft cell — two autofocus inputs
        // would fight for focus and immediately cancel the edit. (Handled
        // by the caller: `editingCell` is only non-null here for a
        // non-draft edit — see the `<GridRow>` call site.)
        const isEditing = editingCell !== null && editingCell.col === colIndex;
        return (
          <GridCell
            key={colIndex}
            r={r}
            colIndex={colIndex}
            value={value}
            isDirty={isDirty}
            isSelected={isRowActive && selectedCol === colIndex}
            isColActive={selectedCol === colIndex}
            isPk={isPk}
            isFk={isFk}
            nav={nav}
            numeric={numericCols[colIndex]}
            isBoolean={booleanCols[colIndex]}
            editable={editable}
            nullText={nullText}
            isEditing={isEditing}
            editDraft={isEditing ? editingCell!.draft : ""}
            findOpen={findOpen}
            findQuery={findQuery}
            isActiveFindMatch={activeMatchCol === colIndex}
            onCellClick={onCellClick}
            onCellDoubleClick={onCellDoubleClick}
            onCellContextMenu={onCellContextMenu}
            onEditDraftChange={onEditDraftChange}
            onEditCommit={onEditCommit}
            onEditCancel={onEditCancel}
          />
        );
      })}
      <div className="grid__spacer" aria-hidden />
    </div>
  );
});

interface GridNewRowProps {
  ni: number;
  draft: Array<string | null>;
  rowStyle: React.CSSProperties;
  /** The *windowed* display order — only the columns currently on screen. */
  order: number[];
  numericCols: boolean[];
  isRowGutterSelected: boolean;
  editingCell: { col: number; draft: string } | null;
  onGutterClick: (e: React.MouseEvent, ni: number) => void;
  onNewCellClick: (ni: number, col: number, currentValue: string | null) => void;
  onEditDraftChange: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCommit: (r: number, col: number, draft: string, isNew?: boolean) => void;
  onEditCancel: () => void;
}

/**
 * One draft (uncommitted, not-yet-inserted) row. Simpler than `GridRow` —
 * draft cells don't participate in the selected-cell "crosshair" (no
 * `col-active`/`selected` styling), so a single row-level `memo()` is
 * enough; no need for the extra per-cell split `GridRow` needs.
 */
const GridNewRow = memo(function GridNewRow({
  ni,
  draft,
  rowStyle,
  order,
  numericCols,
  isRowGutterSelected,
  editingCell,
  onGutterClick,
  onNewCellClick,
  onEditDraftChange,
  onEditCommit,
  onEditCancel,
}: GridNewRowProps) {
  return (
    <div
      className={"grid__row grid__row--new" + (isRowGutterSelected ? " grid__row--rowsel" : "")}
      style={rowStyle}
    >
      <div
        className="grid__gutter grid__gutter--new"
        title="New row — commit with Update to insert it"
        onClick={(e) => onGutterClick(e, ni)}
      >
        +
      </div>
      <div className="grid__spacer" aria-hidden />
      {order.map((colIndex) => {
        const value = draft[colIndex];
        const isEditing = editingCell !== null && editingCell.col === colIndex;
        if (isEditing) {
          return (
            <div
              key={colIndex}
              className={
                "grid__cell grid__cell--editing" +
                (numericCols[colIndex] ? " grid__cell--num" : "")
              }
            >
              <input
                className="grid__cell-input mono"
                autoFocus
                value={editingCell!.draft}
                onFocus={(e) => e.target.select()}
                onChange={(e) => onEditDraftChange(ni, colIndex, e.target.value, true)}
                onBlur={() => onEditCommit(ni, colIndex, editingCell!.draft, true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onEditCommit(ni, colIndex, editingCell!.draft, true);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onEditCancel();
                  }
                }}
              />
            </div>
          );
        }
        return (
          <div
            key={colIndex}
            className={
              "grid__cell grid__cell--newcell" +
              (numericCols[colIndex] ? " grid__cell--num mono" : "") +
              (value === null ? " grid__cell--null" : "")
            }
            title={value ?? "Click to edit (empty leaves the column default)"}
            // A single click on a draft cell starts editing right away — no
            // double-click needed. (Select the whole row via its gutter.)
            onClick={() => onNewCellClick(ni, colIndex, value)}
          >
            <span className="grid__cell-text">{value === null ? "default" : value}</span>
          </div>
        );
      })}
      <div className="grid__spacer" aria-hidden />
    </div>
  );
});

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

/**
 * A dismissible footer banner explaining why the last insert/update/delete
 * failed (duplicate key, foreign-key constraint, etc.). Shown for delete errors
 * even when there are no pending edits, and above the pending bar on a failed
 * commit. Unlike the old truncated inline error, the full message wraps here.
 */
function MutationErrorBar({ tab }: { tab: QueryTab }) {
  const clearUpdateError = useStore((s) => s.clearUpdateError);
  const err = tab.updateError!;
  const detail = [err.code ? `ERROR ${err.code}` : null, err.hint ?? null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mutation-error">
      <span className="mutation-error__glyph">✕</span>
      <div className="mutation-error__body">
        <span className="mutation-error__message">{err.message}</span>
        {detail && <span className="mutation-error__detail mono">{detail}</span>}
      </div>
      <button
        className="mutation-error__close"
        onClick={() => clearUpdateError(tab.id)}
        title="Dismiss"
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
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
            onClick={() => void copyToClipboard(err.message)}
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
/** Ceiling for an explicit double-click auto-fit. Higher than
 *  `MAX_INITIAL_WIDTH`: opening a table shouldn't hand one wide column the
 *  whole viewport, but asking a specific column to fit its content should be
 *  taken more literally. */
const MAX_AUTOFIT_WIDTH = 900;
const CELL_PADDING = 26;
/** Breathing room past an exact fit. Measured widths are exact, which on its
 *  own leaves text touching the cell padding and one sub-pixel rounding away
 *  from an ellipsis — a few px of slack is the difference between "fits" and
 *  "looks like it fits". */
const WIDTH_SLACK = 8;
const WIDTH_SAMPLE_ROWS = 40;
/** `.grid__head`'s own type — fixed chrome, unlike the data cells below it,
 *  whose family *and* size are user settings. Keep in sync with the
 *  `.grid__head` rule in workspace.css. */
const HEAD_FONT_SIZE = 10.5;
const HEAD_LETTER_SPACING = 0.05;
/** Room for the sort caret that appears in a header cell once sorted. */
const HEAD_EXTRA = 12;

/** Lazily-created scratch context for `textWidth`. `undefined` = not tried
 *  yet, `null` = tried and unavailable. */
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Width of `text` in `font` (a CSS `font` shorthand), in px. Falls back to a
 *  crude per-character guess only if a 2D context can't be had at all. */
function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 7.6;
  if (measureCtx.font !== font) measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Resolve the fonts the grid actually renders with. The data cells follow
 *  Settings > Appearance > Table for both family and size (10–18px), which
 *  is exactly why this can't be a characters-times-a-constant estimate — one
 *  constant is only ever right at one font size, and too narrow above it. */
function gridFonts(): { value: string; head: string } {
  const s = getComputedStyle(document.documentElement);
  const size = s.getPropertyValue("--table-font-size").trim() || "12.5px";
  const family = s.getPropertyValue("--table-font").trim() || "sans-serif";
  const mono = s.getPropertyValue("--font-mono").trim() || "monospace";
  return { value: `${size} ${family}`, head: `${HEAD_FONT_SIZE}px ${mono}` };
}

/** Measure a sensible width per column from its header and sampled content.
 *  Header and values are measured separately because they render in
 *  different faces at different sizes. */
function measuredWidths(
  result: QueryResult,
  numericCols: boolean[],
  maxWidth: number,
): number[] {
  const fonts = gridFonts();
  const sample = result.rows.slice(0, WIDTH_SAMPLE_ROWS);
  return result.columns.map((col, i) => {
    let maxPx =
      textWidth(col.name, fonts.head) +
      col.name.length * HEAD_LETTER_SPACING * HEAD_FONT_SIZE +
      HEAD_EXTRA;
    for (const row of sample) {
      const v = row[i];
      if (v == null) continue;
      const w = textWidth(v, fonts.value);
      if (w > maxPx) maxPx = w;
    }
    const floor = numericCols[i] ? 72 : 96;
    // `ceil`, not `round` — rounding a measured width down is exactly the
    // half-pixel that turns a fitting cell into an ellipsized one.
    return Math.max(floor, Math.min(maxWidth, Math.ceil(maxPx + CELL_PADDING + WIDTH_SLACK)));
  });
}

/** Starting width per column when a result first lands. */
function initialWidths(result: QueryResult, numericCols: boolean[]): number[] {
  return measuredWidths(result, numericCols, MAX_INITIAL_WIDTH);
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

/**
 * Compare two cell values for sorting. NULLs always sort last. Treats anything
 * that isn't actually a string as null-like rather than throwing — a second
 * independent guard (alongside the range check at the call site) against a
 * stale sort column ever crashing the render.
 */
function compareCells(
  a: string | null,
  b: string | null,
  numeric: boolean,
  dir: "asc" | "desc",
): number {
  const aOk = typeof a === "string";
  const bOk = typeof b === "string";
  if (!aOk && !bOk) return 0;
  if (!aOk) return 1;
  if (!bOk) return -1;
  const r = numeric ? parseFloat(a) - parseFloat(b) : a.localeCompare(b);
  return dir === "asc" ? r : -r;
}

/** Wrap every case-insensitive occurrence of `query` in `text` with a <mark>. */
function highlightMatches(text: string, query: string, active: boolean): React.ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  if (!lower.includes(q)) return text;
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className={"grid__mark" + (active ? " grid__mark--active" : "")}>
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
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

/** Same "infer from the actual values" approach as `inferNumericColumns` —
 *  and for the same reason: `simple_query` doesn't give us column types.
 *  `t`/`f` is Postgres's canonical boolean text form (`SELECT true` comes
 *  back as the single character `t`) and nothing else in Postgres
 *  serializes to a bare `t`/`f`, so "every non-null value in this column is
 *  exactly `t` or `f`" is a reliable signal — and, unlike a schema lookup,
 *  works for ad-hoc query results too, not just table-browse tabs. */
function inferBooleanColumns(result: QueryResult): boolean[] {
  return result.columns.map((_, i) => {
    let seen = false;
    for (const row of result.rows) {
      const v = row[i];
      if (v == null || v === "") continue;
      seen = true;
      if (v !== "t" && v !== "f") return false;
    }
    return seen;
  });
}

function exportCsv(result: QueryResult, tabTitle: string, delimiter: Delimiter) {
  const showToast = useStore.getState().showToast;
  void saveCsv([result.columns.map((c) => c.name), ...result.rows], tabTitle, delimiter)
    // `null` means the save dialog was dismissed — not worth a notice.
    .then((path) => {
      if (path) showToast(`Saved ${path.split("/").pop()}`);
    })
    .catch((e) => showToast(errorMessage(e), "error"));
}
