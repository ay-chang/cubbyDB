import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatShortcutTitle,
  matchesKeybinding,
  TAB_JUMP_KEYBINDING_IDS,
  useKeybindingStore,
} from "../../lib/keybindings";
import { useActiveTabId, useActiveTabs, useStore } from "../../state/store";
import { AiPanel } from "./AiPanel";
import { CommandPalette } from "./CommandPalette";
import { CubbyPanel } from "./CubbyPanel";
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
import { Toast } from "./Toast";
import { TopBar, useIsFullscreen } from "./TopBar";
import { UpdateBanner } from "./UpdateBanner";
import "./workspace.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 800;
const EDITOR_MIN = 120;
const AI_PANEL_MIN = 300;
const AI_PANEL_MAX = 900;
const CUBBY_PANEL_MIN = 300;
const CUBBY_PANEL_MAX = 900;

export function Workspace() {
  const tabs = useActiveTabs();
  const activeTabId = useActiveTabId();
  const setTabSql = useStore((s) => s.setTabSql);
  const runTab = useStore((s) => s.runTab);
  const historyOpen = useStore((s) => s.historyOpen);
  const savedQueriesOpen = useStore((s) => s.savedQueriesOpen);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);
  const cubbiesOpen = useStore((s) => s.cubbiesOpen);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [editorHeight, setEditorHeight] = useState(280);
  const [aiPanelWidth, setAiPanelWidth] = useState(380);
  const [cubbyPanelWidth, setCubbyPanelWidth] = useState(380);
  const mainRef = useRef<HTMLDivElement>(null);
  const toggleSidebar = useCallback(
    () => setSidebarVisible((visible) => !visible),
    [],
  );
  const sidebarBinding = useKeybindingStore(
    (s) => s.bindings["workspace.toggleSidebar"],
  );
  const { saveDialogOpen, openSaveDialog, closeSaveDialog } = useWorkspaceShortcuts(
    toggleSidebar,
  );

  // Sidebar drag (resizable 200–800px).
  const startSidebarDrag = useDrag((dx, startWidth) => {
    setSidebarWidth(clamp(startWidth + dx, SIDEBAR_MIN, SIDEBAR_MAX));
  }, sidebarWidth);

  // AI panel drag — its resizer sits on the panel's left edge, so dragging
  // left (negative dx) grows it and dragging right shrinks it, the mirror of
  // the sidebar's own resizer above.
  const startAiPanelDrag = useDrag((dx, startWidth) => {
    setAiPanelWidth(clamp(startWidth - dx, AI_PANEL_MIN, AI_PANEL_MAX));
  }, aiPanelWidth);

  // Cubby panel drag — same left-edge resizer as the AI panel above.
  const startCubbyPanelDrag = useDrag((dx, startWidth) => {
    setCubbyPanelWidth(clamp(startWidth - dx, CUBBY_PANEL_MIN, CUBBY_PANEL_MAX));
  }, cubbyPanelWidth);

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
        {sidebarVisible ? (
          <>
            <div className="workspace__sidebar" style={{ width: sidebarWidth }}>
              <SchemaTree onClose={toggleSidebar} />
            </div>
            <div
              className="workspace__resizer workspace__resizer--v"
              onMouseDown={startSidebarDrag}
            />
          </>
        ) : (
          <button
            className="workspace__sidebar-rail"
            onClick={toggleSidebar}
            title={formatShortcutTitle("Show schema sidebar", sidebarBinding)}
            aria-label="Show schema sidebar"
          >
            <svg
              width="19"
              height="19"
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
              <path d="M8 10l2 2-2 2" />
            </svg>
          </button>
        )}

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

        {/* Laid out as a flex sibling (not a fixed overlay, unlike History/
            Saved Queries) so it shrinks the table view instead of covering
            it, with its own drag handle to resize. */}
        {aiPanelOpen && (
          <>
            <div
              className="workspace__resizer workspace__resizer--v"
              onMouseDown={startAiPanelDrag}
            />
            <div className="workspace__ai" style={{ width: aiPanelWidth }}>
              <AiPanel />
            </div>
          </>
        )}

        {/* Same flex-sibling-with-resizer treatment as the AI panel above
            (not a fixed overlay like History/Saved Queries) — a cubby's
            entry list is worth resizing room for. */}
        {cubbiesOpen && (
          <>
            <div
              className="workspace__resizer workspace__resizer--v"
              onMouseDown={startCubbyPanelDrag}
            />
            <div className="workspace__cubby" style={{ width: cubbyPanelWidth }}>
              <CubbyPanel />
            </div>
          </>
        )}
      </div>

      {historyOpen && <HistoryPanel />}
      {savedQueriesOpen && <SavedQueriesPanel />}
      {saveDialogOpen && <SaveQueryDialog onClose={closeSaveDialog} />}
      <Toast />
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
 * Global application-command shortcuts. Every match comes from the persisted
 * keybinding registry; CodeMirror and focused grid controls run first and can
 * claim an event before it reaches this fallback workspace layer.
 */
function useWorkspaceShortcuts(toggleSidebar: () => void) {
  const runTab = useStore((s) => s.runTab);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const newTab = useStore((s) => s.newTab);
  const closeTab = useStore((s) => s.closeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const navigateBack = useStore((s) => s.navigateBack);
  const navigateForward = useStore((s) => s.navigateForward);
  const toggleCommandPalette = useStore((s) => s.toggleCommandPalette);
  const toggleAiPanel = useStore((s) => s.toggleAiPanel);
  const refreshActive = useStore((s) => s.refreshActive);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const bindings = useKeybindingStore((s) => s.bindings);
  const activeTabId = useActiveTabId();
  const tabs = useActiveTabs();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const isFullscreen = useIsFullscreen();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Focused controls (notably CodeMirror and shortcut recording buttons)
      // get first refusal. Settings also shouldn't mutate the workspace behind
      // its modal while somebody is editing a binding.
      if (e.defaultPrevented) return;
      // Rebinding these commands must not expose the webview's underlying
      // reload/close behavior at their former defaults. Escape gets the same
      // treatment while in native fullscreen — otherwise the webview's
      // built-in "exit fullscreen on Escape" default fires ahead of (or
      // instead of) whatever the focused control wants Escape to do.
      if (
        matchesKeybinding(e, "mod+r") ||
        matchesKeybinding(e, "mod+w") ||
        e.key.toLowerCase() === "f5" ||
        (isFullscreen && e.key === "Escape")
      ) {
        e.preventDefault();
      }
      if (settingsOpen || e.repeat) return;

      if (matchesKeybinding(e, bindings["query.run"]) && activeTabId) {
        e.preventDefault();
        void runTab(activeTabId);
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.refresh"])) {
        e.preventDefault();
        void refreshActive();
        return;
      }
      if (matchesKeybinding(e, bindings["query.cancel"])) {
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.running) {
          e.preventDefault();
          cancelQuery();
        }
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.newQuery"])) {
        e.preventDefault();
        void newTab();
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.closeTab"])) {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.commandPalette"])) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.save"])) {
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.kind === "query") {
          e.preventDefault();
          setSaveDialogOpen(true);
        }
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.toggleSidebar"])) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (matchesKeybinding(e, bindings["workspace.toggleAiPanel"])) {
        e.preventDefault();
        toggleAiPanel();
        return;
      }
      if (
        matchesKeybinding(e, bindings["workspace.previousTab"]) ||
        matchesKeybinding(e, bindings["workspace.nextTab"])
      ) {
        if (tabs.length < 2) return;
        e.preventDefault();
        e.stopPropagation();
        const current = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
        const delta = matchesKeybinding(e, bindings["workspace.previousTab"]) ? -1 : 1;
        setActiveTab(tabs[(current + delta + tabs.length) % tabs.length].id);
        return;
      }
      const jumpIndex = TAB_JUMP_KEYBINDING_IDS.findIndex((id) =>
        matchesKeybinding(e, bindings[id]),
      );
      if (jumpIndex !== -1) {
        const target = tabs[jumpIndex];
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        setActiveTab(target.id);
        return;
      }
      if (
        matchesKeybinding(e, bindings["workspace.navigateBack"]) ||
        matchesKeybinding(e, bindings["workspace.navigateForward"])
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (matchesKeybinding(e, bindings["workspace.navigateBack"])) {
          navigateBack();
        } else {
          navigateForward();
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    runTab,
    cancelQuery,
    newTab,
    closeTab,
    setActiveTab,
    navigateBack,
    navigateForward,
    toggleCommandPalette,
    toggleAiPanel,
    refreshActive,
    settingsOpen,
    bindings,
    activeTabId,
    tabs,
    toggleSidebar,
    isFullscreen,
  ]);

  return {
    saveDialogOpen,
    openSaveDialog: () => setSaveDialogOpen(true),
    closeSaveDialog: () => setSaveDialogOpen(false),
  };
}
