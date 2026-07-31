import { useCallback, useEffect, useRef, useState } from "react";

import { useActiveTabId, useActiveTabs, useStore } from "../../state/store";
import { CommandPalette } from "./CommandPalette";
import { EditorTabs } from "./EditorTabs";
import { FunctionDefinitionPane } from "./FunctionDefinitionPane";
import { HistoryPanel } from "./HistoryPanel";
import { ResultsPane } from "./ResultsPane";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { SavedQueriesPanel } from "./SavedQueriesPanel";
import { SchemaTree } from "./SchemaTree";
import { SequenceDetailsPane } from "./SequenceDetailsPane";
import { SqlEditor } from "./SqlEditor";
import { TableStructurePane } from "./TableStructurePane";
import { TopBar } from "./TopBar";
import { UpdateBanner } from "./UpdateBanner";
import "./workspace.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 360;
const EDITOR_MIN = 120;

export function Workspace() {
  const tabs = useActiveTabs();
  const activeTabId = useActiveTabId();
  const setTabSql = useStore((s) => s.setTabSql);
  const runTab = useStore((s) => s.runTab);
  const historyOpen = useStore((s) => s.historyOpen);
  const savedQueriesOpen = useStore((s) => s.savedQueriesOpen);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const { saveDialogOpen, openSaveDialog, closeSaveDialog } = useGlobalRunShortcut();

  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [editorHeight, setEditorHeight] = useState(280);
  const mainRef = useRef<HTMLDivElement>(null);

  // Sidebar drag (resizable 200–360px, per spec).
  const startSidebarDrag = useDrag((dx, startWidth) => {
    setSidebarWidth(clamp(startWidth + dx, SIDEBAR_MIN, SIDEBAR_MAX));
  }, sidebarWidth);

  // Editor/results horizontal split.
  const startEditorDrag = useDrag(
    (_, startHeight, _dx, dy) => {
      const container = mainRef.current;
      const maxHeight = container ? container.clientHeight - 160 : 600;
      setEditorHeight(clamp(startHeight + dy, EDITOR_MIN, maxHeight));
    },
    editorHeight,
  );

  return (
    <div className="workspace">
      <TopBar />
      <UpdateBanner />
      <div className="workspace__body">
        <div className="workspace__sidebar" style={{ width: sidebarWidth }}>
          <SchemaTree />
        </div>
        <div
          className="workspace__resizer workspace__resizer--v"
          onMouseDown={startSidebarDrag}
        />

        <div className="workspace__main" ref={mainRef}>
          {activeTab ? (
            <>
              <EditorTabs onSaveQuery={openSaveDialog} />
              {activeTab.kind === "query" && (
                <>
                  <div
                    className="workspace__editor"
                    style={{ height: editorHeight }}
                  >
                    <SqlEditor
                      value={activeTab.sql}
                      onChange={(sql) => setTabSql(activeTab.id, sql)}
                      onRun={(sql) => void runTab(activeTab.id, sql)}
                    />
                  </div>
                  <div
                    className="workspace__resizer workspace__resizer--h"
                    onMouseDown={startEditorDrag}
                  />
                </>
              )}
              {/* Keyed by tab id so switching tabs fully resets each pane's
                  internal state (sort, selection, column layout) instead of
                  reusing it with stale state pointed at the wrong table. */}
              {activeTab.kind === "structure" ? (
                <TableStructurePane key={activeTab.id} tab={activeTab} />
              ) : activeTab.kind === "function" ? (
                <FunctionDefinitionPane key={activeTab.id} tab={activeTab} />
              ) : activeTab.kind === "sequence" ? (
                <SequenceDetailsPane key={activeTab.id} tab={activeTab} />
              ) : (
                <ResultsPane key={activeTab.id} tab={activeTab} />
              )}
            </>
          ) : (
            <div className="workspace__empty">
              <p>No open tabs.</p>
            </div>
          )}
        </div>
      </div>

      {historyOpen && <HistoryPanel />}
      {savedQueriesOpen && <SavedQueriesPanel />}
      {saveDialogOpen && <SaveQueryDialog onClose={closeSaveDialog} />}
      <CommandPalette />
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Minimal drag helper: returns an onMouseDown that tracks pointer movement and
 * calls `onMove(dx, startValue, dxRaw, dy)` until the button is released.
 */
function useDrag(
  onMove: (dx: number, startValue: number, dxRaw: number, dy: number) => void,
  startValue: number,
) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const startValueRef = useRef(startValue);
  startValueRef.current = startValue;

  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = startValueRef.current;
    document.body.style.userSelect = "none";

    const move = (ev: MouseEvent) => {
      onMoveRef.current(ev.clientX - startX, base, ev.clientX - startX, ev.clientY - startY);
    };
    const up = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);
}

/**
 * Global workspace shortcuts that work even when the editor isn't focused:
 * Cmd/Ctrl+Enter runs the active tab's whole query (the editor's own keymap
 * handles the smarter statement/selection version while it has focus),
 * Escape cancels the active tab's query if it's currently running,
 * Cmd/Ctrl+T opens a new query tab, Cmd/Ctrl+W closes the active tab
 * (routed through the store's own unsaved-edits confirmation), Cmd/Ctrl+K
 * toggles the quick-jump command palette, and Cmd/Ctrl+S opens the "save as
 * query" dialog when the active tab is a `query` tab (a `table` tab's own
 * Cmd/Ctrl+S, for committing pending cell edits, lives in
 * `PendingEditsBar` — the two never both mount for the same tab kind, so
 * there's no collision).
 */
function useGlobalRunShortcut() {
  const runTab = useStore((s) => s.runTab);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const newTab = useStore((s) => s.newTab);
  const closeTab = useStore((s) => s.closeTab);
  const toggleCommandPalette = useStore((s) => s.toggleCommandPalette);
  const activeTabId = useActiveTabId();
  const tabs = useActiveTabs();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && activeTabId) {
        e.preventDefault();
        void runTab(activeTabId);
        return;
      }
      if (e.key === "Escape") {
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.running) {
          e.preventDefault();
          cancelQuery();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void newTab();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.kind === "query") {
          e.preventDefault();
          setSaveDialogOpen(true);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runTab, cancelQuery, newTab, closeTab, toggleCommandPalette, activeTabId, tabs]);

  return {
    saveDialogOpen,
    openSaveDialog: () => setSaveDialogOpen(true),
    closeSaveDialog: () => setSaveDialogOpen(false),
  };
}
