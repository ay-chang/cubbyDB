import { useRef, useState } from "react";

import { formatShortcutTitle, useKeybindingStore } from "../../lib/keybindings";
import { useActiveTabId, useActiveTabs, useStore } from "../../state/store";

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
  const bindings = useKeybindingStore((s) => s.bindings);

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    fromIndex: number;
    dx: number;
    targetIndex: number;
    width: number;
  } | null>(null);

  const DRAG_THRESHOLD = 5;
  const onTabMouseDown =
    (index: number, tabId: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // A press on the close or save button isn't a tab press.
      if ((e.target as HTMLElement).closest(".tab__close, .tab__save")) return;
      e.preventDefault();

      const startX = e.clientX;
      let dragging = false;
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
        setDrag((d) => {
          if (d && d.fromIndex !== d.targetIndex) {
            reorderTab(d.fromIndex, d.targetIndex);
          }
          return null;
        });
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

  return (
    <div className="tabs" ref={containerRef}>
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
    </div>
  );
}
