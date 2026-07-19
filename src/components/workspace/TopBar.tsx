import { useStore } from "../../state/store";

/** The 42px application top bar: brand mark, connection pill, and actions. */
export function TopBar() {
  const current = useStore((s) => s.current);
  const historyOpen = useStore((s) => s.historyOpen);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const refreshSchema = useStore((s) => s.refreshSchema);
  const disconnect = useStore((s) => s.disconnect);
  const openSettings = useStore((s) => s.openSettings);

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar__left">
        <div className="brand-mark" aria-hidden>
          <span />
        </div>
        {current && (
          <div className="conn-pill">
            <span className="conn-pill__dot" />
            <span className="conn-pill__name">{current.name}</span>
            <span className="conn-pill__meta mono">
              Postgres {current.info.serverVersion}
            </span>
          </div>
        )}
      </div>

      <div className="topbar__right">
        <button
          className={"topbar__btn" + (historyOpen ? " topbar__btn--active" : "")}
          onClick={toggleHistory}
          title="Query history"
        >
          History
        </button>
        <button
          className="topbar__btn"
          onClick={() => void refreshSchema()}
          title="Refresh schema"
        >
          Refresh
        </button>
        <button
          className="topbar__btn"
          onClick={() => void disconnect()}
          title="Disconnect"
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
    </div>
  );
}
