import { useEffect, useRef, useState } from "react";

import { formatShortcutTitle, useKeybindingStore } from "../../lib/keybindings";
import {
  accentPaletteFor,
  tabCubbyEntry,
  THEME_MODE,
  useActiveCubby,
  useActiveTabId,
  useActiveTabs,
  useStore,
} from "../../state/store";

/**
 * The tab strip above the editor. Active tab carries a 2px accent underline.
 * Tabs are reorderable by dragging (pointer-based, since HTML5 drag is
 * unreliable in the app's webview); a press that doesn't move past a small
 * threshold is treated as a plain click that activates the tab.
 */
export function EditorTabs({ onSaveQuery }: { onSaveQuery: () => void }) {
  const tabs = useActiveTabs();
  const activeTabId = useActiveTabId();
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const newTab = useStore((s) => s.newTab);
  const reorderTab = useStore((s) => s.reorderTab);
  const activeCubby = useActiveCubby();
  const addEntryToCubby = useStore((s) => s.addEntryToCubby);
  const bindings = useKeybindingStore((s) => s.bindings);

  // A tagged connection's color carries over to its active tab's highlight
  // — same source (`ConnectionColorMenu` in TopBar.tsx) and the same
  // `--conn-color`/`--conn-color-tint` custom properties `ResultsPane`
  // already sets for the connection-tinted results border/fill, just
  // applied to the tab strip instead. Untagged connections fall back to the
  // plain accent color via the CSS `var(..., fallback)` in `.tab--active`.
  const connColor = useStore((s) => {
    const id = s.activeConnectionId;
    return id ? (s.connections[id]?.color ?? null) : null;
  });
  const theme = useStore((s) => s.theme);
  const connPalette = connColor ? accentPaletteFor(connColor, THEME_MODE[theme]) : null;
  const connStyle = connPalette
    ? ({
        "--conn-color": connPalette.accent,
        "--conn-color-tint": connPalette.accentTint,
      } as React.CSSProperties)
    : undefined;

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    fromIndex: number;
    dx: number;
    targetIndex: number;
    width: number;
  } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // Dismiss the context menu on any outside interaction — same pattern the
  // schema tree's own context menu uses.
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

  const DRAG_THRESHOLD = 5;
  const onTabMouseDown =
    (index: number, tabId: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // A press on the close or save button isn't a tab press.
      if ((e.target as HTMLElement).closest(".tab__close, .tab__save")) return;
      e.preventDefault();

      const startX = e.clientX;
      let dragging = false;
      // Where the drag currently wants to land. Tracked here rather than read
      // back out of `drag` on mouseup: the commit has to happen outside the
      // `setDrag` updater, because an updater must be pure and StrictMode
      // double-invokes it — which ran `reorderTab` twice and, for a swap of
      // two neighbors, landed the tab right back where it started.
      let targetIndex = index;
      const els = containerRef.current
        ? Array.from(containerRef.current.querySelectorAll<HTMLElement>(".tab"))
        : [];
      const centers = els.map((el) => el.offsetLeft + el.offsetWidth / 2);
      const width = els[index]?.offsetWidth ?? 0;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD) return;
          dragging = true;
          document.body.style.userSelect = "none";
        }
        const center = centers[index] + dx;
        let target = index;
        while (target < centers.length - 1 && center > centers[target + 1]) target += 1;
        while (target > 0 && center < centers[target - 1]) target -= 1;
        targetIndex = target;
        setDrag({ fromIndex: index, dx, targetIndex: target, width });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        if (!dragging) {
          setActiveTab(tabId);
          return;
        }
        setDrag(null);
        if (targetIndex !== index) reorderTab(index, targetIndex);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

  // Transform for each tab during a drag: the dragged one follows the pointer,
  // the tabs it's passing shift aside to open a gap.
  const tabStyle = (index: number): React.CSSProperties => {
    if (!drag) return {};
    if (index === drag.fromIndex) {
      return {
        transform: `translateX(${drag.dx}px)`,
        transition: "none",
        zIndex: 3,
      };
    }
    if (drag.targetIndex > drag.fromIndex && index > drag.fromIndex && index <= drag.targetIndex) {
      return { transform: `translateX(${-drag.width}px)` };
    }
    if (drag.targetIndex < drag.fromIndex && index >= drag.targetIndex && index < drag.fromIndex) {
      return { transform: `translateX(${drag.width}px)` };
    }
    return {};
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) ?? null : null;
  const menuEntry = menuTab ? tabCubbyEntry(menuTab) : null;
  const addDisabledReason = !activeCubby
    ? "Open a cubby first"
    : !menuEntry
      ? "Save this query first"
      : null;

  return (
    <div className="tabs" ref={containerRef} style={connStyle}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={
              "tab" +
              (active ? " tab--active" : "") +
              (drag ? " tab--sliding" : "") +
              (drag && drag.fromIndex === index ? " tab--dragging" : "")
            }
            style={tabStyle(index)}
            onMouseDown={onTabMouseDown(index, tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            // Fixed-width tabs (see `.tab` in workspace.css) truncate a long
            // title with an ellipsis, so the full name — otherwise only
            // visible by widening the pane — is one hover away.
            title={tab.title}
          >
            {tab.kind === "function" || tab.kind === "sequence" ? (
              // Plain Latin/ASCII characters — universally present with
              // predictable metrics, so a text glyph is fine here.
              <span className="tab__marker mono">{tab.kind === "function" ? "ƒ" : "#"}</span>
            ) : tab.kind === "table" ? (
              <TableTabIcon />
            ) : tab.kind === "structure" ? (
              <StructureTabIcon />
            ) : tab.kind === "whatsnew" ? (
              <WhatsNewTabIcon />
            ) : tab.kind === "schemaCompare" ? (
              <SchemaCompareTabIcon />
            ) : tab.kind === "erDiagram" ? (
              <ErdTabIcon />
            ) : (
              <QueryTabIcon />
            )}
            <span className="tab__title">{tab.title}</span>
            {tab.kind === "query" && active && (
              <span
                className="tab__save"
                onClick={(e) => {
                  e.stopPropagation();
                  onSaveQuery();
                }}
                title={
                  tab.savedQueryId
                    ? "Update saved query"
                    : formatShortcutTitle("Save as query", bindings["workspace.save"])
                }
              >
                {tab.savedQueryId ? "✓" : "⇩"}
              </span>
            )}
            <span
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title={formatShortcutTitle("Close tab", bindings["workspace.closeTab"])}
            >
              ×
            </span>
          </div>
        );
      })}
      <button
        className="tab__add"
        onClick={() => newTab()}
        title={formatShortcutTitle("New query tab", bindings["workspace.newQuery"])}
      >
        +
      </button>

      {menu && menuTab && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Stays visible but disabled when it can't act, so the reason
              ("open a cubby first", "save this query first") is discoverable
              rather than the menu just appearing empty. */}
          <button
            className="context-menu__item"
            disabled={addDisabledReason !== null}
            title={
              addDisabledReason ??
              formatShortcutTitle("Add to cubby", bindings["workspace.addToCubby"])
            }
            onClick={() => {
              setMenu(null);
              if (activeCubby && menuEntry) void addEntryToCubby(activeCubby.id, menuEntry);
            }}
          >
            {addDisabledReason ?? `Add to ${activeCubby?.name}`}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The four tab-marker glyphs below (table/structure/What's New/query) are
 * drawn as SVG rather than left as Unicode block/star/diamond characters
 * (▦ ▤ ✦ ◆, the previous approach): those symbol codepoints are exactly the
 * class of glyph most prone to landing outside a font's own metrics — a
 * different fallback font can substitute in per-character, each with its
 * own ascent/descent, so even a perfectly flex-centered `.tab__marker` box
 * can end up visibly off against the adjacent title text. `ƒ` and `#`
 * (plain Latin/ASCII) don't have that problem and are left as text glyphs
 * above. `viewBox="0 0 16 16"` at 12x12 roughly matches the previous
 * glyphs' visual weight at the tab strip's font size.
 */
function TableTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="1.5" y1="6.5" x2="14.5" y2="6.5" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="13.5" />
    </svg>
  );
}

/** Two horizontal dividers only (no vertical) — reads as a row/column
 *  listing rather than `TableTabIcon`'s grid, so the two stay visually
 *  distinct at a glance despite sharing the same outer square. */
function StructureTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="1.5" y1="6" x2="14.5" y2="6" />
      <line x1="1.5" y1="9.5" x2="14.5" y2="9.5" />
    </svg>
  );
}

function WhatsNewTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}

/** Two small offset rectangles with a short connecting line — reads as
 *  "comparing two things" without relying on a Unicode glyph like `⇄`,
 *  which has the same cross-font metric-drift problem the other hand-drawn
 *  icons above already avoid. */
function SchemaCompareTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1" y="3" width="6" height="10" rx="1" />
      <rect x="9" y="3" width="6" height="10" rx="1" />
      <line x1="7.5" y1="8" x2="8.5" y2="8" />
    </svg>
  );
}

/** Three small connected nodes — reads as "a diagram/graph of related
 *  things", distinct from `SchemaCompareTabIcon`'s two-boxes-one-line
 *  shape, same hand-drawn-SVG convention as every other tab icon here. */
function ErdTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="4" x2="12" y2="4" />
      <line x1="4" y1="4" x2="4" y2="12" />
      <line x1="4" y1="12" x2="12" y2="12" />
      <rect x="2" y="2" width="4" height="4" rx="1" />
      <rect x="10" y="2" width="4" height="4" rx="1" />
      <rect x="2" y="10" width="4" height="4" rx="1" />
    </svg>
  );
}

/** A plain query tab's marker — the fallback case for any `tab.kind` not
 *  otherwise handled above. Filled, to match the previous "◆" glyph's own
 *  weight (solid, not outlined, unlike the two grid icons above it). */
function QueryTabIcon() {
  return (
    <svg
      className="tab__marker"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" />
    </svg>
  );
}
