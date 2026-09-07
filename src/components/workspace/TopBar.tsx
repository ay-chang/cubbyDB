import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import {
  formatShortcutTitle,
  matchesKeybinding,
  useKeybindingStore,
} from "../../lib/keybindings";
import { ConnectionScreen } from "../connection/ConnectionScreen";
import { Spinner } from "../common/Spinner";
import {
  CheckIcon,
  CubbyIcon,
  HistoryIcon,
  RefreshIcon,
  SavedIcon,
} from "./topBarIcons";
import {
  accentPaletteFor,
  THEME_MODE,
  useActiveCubby,
  useActiveSchemaLoading,
  useStore,
} from "../../state/store";

/** True on macOS, where the window is configured (`tauri.conf.json`,
 *  `titleBarStyle: "Overlay"`) with no native title bar — just the traffic
 *  lights floating over the webview at `trafficLightPosition` — so the top
 *  bar needs to leave them room on the left, *except* in true fullscreen,
 *  where macOS removes the traffic lights entirely (there's no windowed
 *  chrome to draw them over) and the reserved space would just be a dead
 *  gap. Windows/Linux keep their normal native title bar above this bar
 *  entirely, so no reservation is ever needed there. `@tauri-apps/plugin-os`
 *  would be the "proper" way to check the OS, but pulling in a whole plugin
 *  (Rust dependency + capability grant) isn't worth it for one CSS class —
 *  the webview's own UA string already says so. */
const isMacOs = navigator.userAgent.includes("Mac");

/** Tracks fullscreen state — `false` outside macOS (never checked) and falls
 *  back to `false` if the Tauri window API isn't available, e.g. this
 *  component rendering outside a real Tauri window. Also used by
 *  `useWorkspaceShortcuts` to stop Escape from falling through to the
 *  webview's native "exit fullscreen" default. */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!isMacOs) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      const sync = () => {
        win
          .isFullscreen()
          .then((v) => {
            if (!cancelled) setIsFullscreen(v);
          })
          .catch(() => {});
      };
      sync();
      win
        .onResized(sync)
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Not running inside a real Tauri window (e.g. a plain browser preview).
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return isFullscreen;
}

/** The 42px application top bar: connection switcher and actions. */
export function TopBar() {
  const isFullscreen = useIsFullscreen();
  const theme = useStore((s) => s.theme);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const switchConnection = useStore((s) => s.switchConnection);
  const historyOpen = useStore((s) => s.historyOpen);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const savedQueriesOpen = useStore((s) => s.savedQueriesOpen);
  const toggleSavedQueries = useStore((s) => s.toggleSavedQueries);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);
  const toggleAiPanel = useStore((s) => s.toggleAiPanel);
  const cubbiesOpen = useStore((s) => s.cubbiesOpen);
  const toggleCubbies = useStore((s) => s.toggleCubbies);
  const activeCubby = useActiveCubby();
  const refreshActive = useStore((s) => s.refreshActive);
  const disconnect = useStore((s) => s.disconnect);
  const openSettings = useStore((s) => s.openSettings);
  const compactTopBar = useStore((s) => s.compactTopBar);
  const editSessionId = useStore((s) => s.editConnectionSessionId);
  const openEditConnection = useStore((s) => s.openEditConnection);
  const closeEditConnection = useStore((s) => s.closeEditConnection);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const refreshBinding = useKeybindingStore(
    (s) => s.bindings["workspace.refresh"],
  );
  const newConnectionBinding = useKeybindingStore(
    (s) => s.bindings["workspace.newConnection"],
  );
  const aiPanelBinding = useKeybindingStore(
    (s) => s.bindings["workspace.toggleAiPanel"],
  );
  const cubbiesBinding = useKeybindingStore(
    (s) => s.bindings["workspace.toggleCubbies"],
  );
  const settingsBinding = useKeybindingStore(
    (s) => s.bindings["workspace.openSettings"],
  );
  const [addOpen, setAddOpen] = useState(false);
  const [pillMenuSessionId, setPillMenuSessionId] = useState<string | null>(null);
  const schemaLoading = useActiveSchemaLoading();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        settingsOpen ||
        editSessionId ||
        !matchesKeybinding(event, newConnectionBinding)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setAddOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editSessionId, newConnectionBinding, settingsOpen]);
  // Flashed briefly after a refresh completes, so a fast reload (the common
  // case) still gives visible confirmation instead of the spinner just
  // blinking past too quickly to register.
  const [justRefreshed, setJustRefreshed] = useState(false);
  const justRefreshedTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (justRefreshedTimer.current) window.clearTimeout(justRefreshedTimer.current);
  }, []);

  const handleRefresh = () => {
    void refreshActive().then(() => {
      setJustRefreshed(true);
      if (justRefreshedTimer.current) window.clearTimeout(justRefreshedTimer.current);
      justRefreshedTimer.current = window.setTimeout(() => setJustRefreshed(false), 1200);
    });
  };

  const slots = Object.values(connections);

  // The traffic lights anchor the top-left corner in windowed mode; true
  // fullscreen removes them entirely (no windowed chrome to draw them over),
  // leaving that corner empty — the brand mark fills it back in exactly
  // when the traffic lights aren't there to do that job themselves.
  const showBrandMark = !isMacOs || isFullscreen;

  return (
    <div
      className={"topbar" + (isMacOs && !isFullscreen ? " topbar--inset-traffic-lights" : "")}
      data-tauri-drag-region
    >
      <div className="topbar__left">
        {showBrandMark && (
          <div className="brand-mark" aria-hidden>
            <span />
          </div>
        )}
        <div className="conn-switcher">
          {slots.map((slot) => (
            <div
              key={slot.sessionId}
              className={
                "conn-pill conn-pill--switch" +
                (slot.sessionId === activeConnectionId ? " conn-pill--active" : "") +
                (slot.color ? " conn-pill--tagged" : "")
              }
              style={
                slot.color
                  ? ({
                      "--conn-tag-color": accentPaletteFor(slot.color, THEME_MODE[theme]).accent,
                    } as React.CSSProperties)
                  : undefined
              }
              onClick={() => switchConnection(slot.sessionId)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPillMenuSessionId(slot.sessionId);
              }}
              title={
                (slot.sessionId === activeConnectionId
                  ? slot.current.name
                  : `Switch to ${slot.current.name}`) + " (right-click for options)"
              }
            >
              <span className="conn-pill__dot" />
              <span className="conn-pill__name">{slot.current.name}</span>
              {!compactTopBar && slot.sessionId === activeConnectionId && (
                <span className="conn-pill__meta mono">
                  Postgres {slot.current.info.serverVersion}
                </span>
              )}
              <span
                className="conn-pill__close"
                onClick={(e) => {
                  e.stopPropagation();
                  void disconnect(slot.sessionId);
                }}
                title={`Disconnect ${slot.current.name}`}
              >
                ×
              </span>
              {pillMenuSessionId === slot.sessionId && (
                <ConnectionPillMenu
                  onEdit={() => {
                    openEditConnection(slot.sessionId);
                    setPillMenuSessionId(null);
                  }}
                  onClose={() => setPillMenuSessionId(null)}
                />
              )}
            </div>
          ))}
          <button
            className="conn-switcher__add"
            onClick={() => setAddOpen(true)}
            title={formatShortcutTitle("Add another connection", newConnectionBinding)}
            aria-label="Add another connection"
          >
            +
          </button>
        </div>
      </div>

      <div className="topbar__right">
        {/* Leads the cluster rather than sitting inside it: it's the one
            plain-text action here, and wedged between icons it read as though
            it belonged to them. There's no conventional icon for "ask an AI"
            the way there is for a bookmark or a clock, so it keeps its name.

            Everything after it is icon-only, which makes `data-tip` (an
            instant hover label — see `[data-tip]` in workspace.css) the only
            thing naming those buttons. Native `title` is deliberately *not*
            set alongside it: the OS tooltip would show up a second later and
            say the same thing twice. `aria-label` covers screen readers. */}
        <button
          className={"topbar__btn" + (aiPanelOpen ? " topbar__btn--active" : "")}
          onClick={toggleAiPanel}
          data-tip={formatShortcutTitle("Ask AI", aiPanelBinding)}
        >
          Ask AI
        </button>
        {/* Cubby keeps its label only while a cubby is actually open — that
            label is the cubby's *name*, real context worth the space. Idle,
            there's nothing to say that the icon doesn't. */}
        <button
          className={
            "topbar__btn" +
            (activeCubby ? " topbar__btn--cubby" : " topbar__btn--icon") +
            (cubbiesOpen || activeCubby ? " topbar__btn--active" : "")
          }
          onClick={toggleCubbies}
          data-tip={formatShortcutTitle(
            activeCubby ? `Cubby: ${activeCubby.name}` : "Cubbies",
            cubbiesBinding,
          )}
          aria-label={activeCubby ? `Cubby: ${activeCubby.name}` : "Cubbies"}
        >
          <CubbyIcon />
          {activeCubby && <span className="topbar__btn__label">{activeCubby.name}</span>}
        </button>
        <span className="topbar__divider" aria-hidden />
        <div className="topbar__group">
          <button
            className={
              "topbar__btn topbar__btn--icon" +
              (savedQueriesOpen ? " topbar__btn--active" : "")
            }
            onClick={toggleSavedQueries}
            data-tip="Saved queries"
            aria-label="Saved queries"
          >
            <SavedIcon />
          </button>
          <button
            className={
              "topbar__btn topbar__btn--icon" + (historyOpen ? " topbar__btn--active" : "")
            }
            onClick={toggleHistory}
            data-tip="Query history"
            aria-label="Query history"
          >
            <HistoryIcon />
          </button>
          <button
            className={
              "topbar__btn topbar__btn--icon" +
              (schemaLoading ? " topbar__btn--loading" : "") +
              (justRefreshed ? " topbar__btn--active" : "")
            }
            onClick={handleRefresh}
            disabled={schemaLoading}
            data-tip={
              schemaLoading
                ? "Refreshing…"
                : justRefreshed
                  ? "Refreshed"
                  : formatShortcutTitle("Refresh schema & data", refreshBinding)
            }
            aria-label="Refresh"
          >
            {schemaLoading ? <Spinner /> : justRefreshed ? <CheckIcon /> : <RefreshIcon />}
          </button>
        </div>
        <span className="topbar__divider" aria-hidden />
        <button
          className="topbar__btn topbar__btn--icon"
          onClick={() => openSettings()}
          data-tip={formatShortcutTitle("Settings", settingsBinding)}
          aria-label="Settings"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {addOpen && (
        <div className="settings-overlay" onClick={() => setAddOpen(false)}>
          <div
            className="add-connection-card"
            role="dialog"
            aria-modal="true"
            aria-label="Add connection"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-panel__head">
              <span className="settings-panel__title">Add connection</span>
              <button
                className="settings-panel__close"
                onClick={() => setAddOpen(false)}
                title="Close"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <ConnectionScreen embedded onConnected={() => setAddOpen(false)} />
          </div>
        </div>
      )}

      {editSessionId && (
        <div className="settings-overlay" onClick={closeEditConnection}>
          <div
            className="add-connection-card"
            role="dialog"
            aria-modal="true"
            aria-label="Edit connection"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-panel__head">
              <span className="settings-panel__title">Edit connection</span>
              <button
                className="settings-panel__close"
                onClick={closeEditConnection}
                title="Close"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <ConnectionScreen
              embedded
              editSessionId={editSessionId}
              onConnected={closeEditConnection}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Small right-click popover on a connection pill. Just "Edit" for now (which
 *  opens the same form the pencil icon used to, including its color picker)
 *  — a dropdown rather than a bare action so there's somewhere to add more
 *  to later without redesigning the interaction. */
function ConnectionPillMenu(props: { onEdit: () => void; onClose: () => void }) {
  const { onEdit, onClose } = props;
  return (
    <>
      {/* Full-screen click-catcher to dismiss on outside click, same idiom
          as the results-grid FK context menu. */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 90 }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />
      <div className="pill-menu" onClick={(e) => e.stopPropagation()}>
        <button className="context-menu__item" onClick={onEdit}>
          Edit
        </button>
      </div>
    </>
  );
}
