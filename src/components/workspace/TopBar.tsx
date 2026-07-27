import { useEffect, useRef, useState } from "react";

import { ConnectionScreen } from "../connection/ConnectionScreen";
import { Spinner } from "../common/Spinner";
import { useActiveSchemaLoading, useStore } from "../../state/store";

/** The 42px application top bar: brand mark, connection switcher, and actions. */
export function TopBar() {
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const switchConnection = useStore((s) => s.switchConnection);
  const historyOpen = useStore((s) => s.historyOpen);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const savedQueriesOpen = useStore((s) => s.savedQueriesOpen);
  const toggleSavedQueries = useStore((s) => s.toggleSavedQueries);
  const refreshSchema = useStore((s) => s.refreshSchema);
  const disconnect = useStore((s) => s.disconnect);
  const openSettings = useStore((s) => s.openSettings);
  const compactTopBar = useStore((s) => s.compactTopBar);
  const [addOpen, setAddOpen] = useState(false);
  const [editSessionId, setEditSessionId] = useState<string | null>(null);
  const schemaLoading = useActiveSchemaLoading();
  // Flashed briefly after a refresh completes, so a fast reload (the common
  // case) still gives visible confirmation instead of the spinner just
  // blinking past too quickly to register.
  const [justRefreshed, setJustRefreshed] = useState(false);
  const justRefreshedTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (justRefreshedTimer.current) window.clearTimeout(justRefreshedTimer.current);
  }, []);

  const handleRefresh = () => {
    void refreshSchema().then(() => {
      setJustRefreshed(true);
      if (justRefreshedTimer.current) window.clearTimeout(justRefreshedTimer.current);
      justRefreshedTimer.current = window.setTimeout(() => setJustRefreshed(false), 1200);
    });
  };

  const slots = Object.values(connections);
  const active = activeConnectionId ? connections[activeConnectionId] : null;

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar__left">
        <div className="brand-mark" aria-hidden>
          <span />
        </div>
        <div className="conn-switcher">
          {slots.map((slot) => (
            <div
              key={slot.sessionId}
              className={
                "conn-pill conn-pill--switch" +
                (slot.sessionId === activeConnectionId ? " conn-pill--active" : "")
              }
              onClick={() => switchConnection(slot.sessionId)}
              title={
                slot.sessionId === activeConnectionId
                  ? slot.current.name
                  : `Switch to ${slot.current.name}`
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
                className="conn-pill__edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditSessionId(slot.sessionId);
                }}
                title={`Edit ${slot.current.name}`}
              >
                ✎
              </span>
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
            </div>
          ))}
          <button
            className="conn-switcher__add"
            onClick={() => setAddOpen(true)}
            title="Add another connection"
            aria-label="Add another connection"
          >
            +
          </button>
        </div>
      </div>

      <div className="topbar__right">
        <button
          className={"topbar__btn" + (savedQueriesOpen ? " topbar__btn--active" : "")}
          onClick={toggleSavedQueries}
          title="Saved queries"
        >
          Saved
        </button>
        <button
          className={"topbar__btn" + (historyOpen ? " topbar__btn--active" : "")}
          onClick={toggleHistory}
          title="Query history"
        >
          History
        </button>
        <button
          className={
            "topbar__btn topbar__btn--refresh" +
            (schemaLoading ? " topbar__btn--loading" : "") +
            (justRefreshed ? " topbar__btn--active" : "")
          }
          onClick={handleRefresh}
          disabled={schemaLoading}
          title="Refresh schema"
        >
          {schemaLoading ? (
            <>
              <Spinner /> Refreshing…
            </>
          ) : justRefreshed ? (
            "Refreshed ✓"
          ) : (
            "Refresh"
          )}
        </button>
        <button
          className="topbar__btn"
          onClick={() => void disconnect()}
          title={active ? `Disconnect ${active.current.name}` : "Disconnect"}
        >
          Disconnect
        </button>
        <button
          className="topbar__btn topbar__btn--icon"
          onClick={openSettings}
          title="Settings"
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
        <div className="settings-overlay" onClick={() => setEditSessionId(null)}>
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
                onClick={() => setEditSessionId(null)}
                title="Close"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <ConnectionScreen
              embedded
              editSessionId={editSessionId}
              onConnected={() => setEditSessionId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
