import { useStore } from "../../state/store";

/** The 42px application top bar: brand mark, connection pill, and actions. */
export function TopBar() {
  const current = useStore((s) => s.current);
  const historyOpen = useStore((s) => s.historyOpen);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const refreshSchema = useStore((s) => s.refreshSchema);
  const disconnect = useStore((s) => s.disconnect);

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
      </div>
    </div>
  );
}
