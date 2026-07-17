import { useStore } from "../../state/store";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Slide-in panel listing recent queries; click one to re-run it in a new tab. */
export function HistoryPanel() {
  const history = useStore((s) => s.history);
  const rerun = useStore((s) => s.rerunFromHistory);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const clearHistory = useStore((s) => s.clearHistory);

  return (
    <div className="history">
      <div className="history__head">
        <span className="caption">Query history</span>
        <div className="history__head-actions">
          {history.length > 0 && (
            <button
              className="history__clear"
              onClick={() => void clearHistory()}
              title="Delete all history"
            >
              Clear
            </button>
          )}
          <button className="history__close" onClick={toggleHistory} title="Close">
            ×
          </button>
        </div>
      </div>
      <div className="history__list">
        {history.length === 0 && (
          <p className="history__empty">No queries yet.</p>
        )}
        {history.map((entry, i) => (
          <button
            key={i}
            className="history__item"
            onClick={() => rerun(entry.sql)}
            title="Open in a new tab and run"
          >
            <div className="history__item-head">
              <span
                className={
                  "history__status" +
                  (entry.success
                    ? " history__status--ok"
                    : " history__status--err")
                }
              />
              <span className="history__time mono">
                {formatTime(entry.executedAt)}
              </span>
              <span className="history__meta mono">
                {entry.success
                  ? `${entry.rowCount ?? 0} rows · ${entry.elapsedMs ?? 0} ms`
                  : "failed"}
              </span>
            </div>
            <code className="history__sql">{entry.sql.trim()}</code>
            {!entry.success && entry.error && (
              <span className="history__error mono">{entry.error}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
