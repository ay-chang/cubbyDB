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
            <span className="tab__marker mono">
              {tab.kind === "table"
                ? "▦"
                : tab.kind === "structure"
                  ? "▤"
                  : tab.kind === "function"
                    ? "ƒ"
                    : tab.kind === "sequence"
                      ? "#"
                      : tab.kind === "whatsnew"
                        ? "✦"
                        : "◆"}
            </span>
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
