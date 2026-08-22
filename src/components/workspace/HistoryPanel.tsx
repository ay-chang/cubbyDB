import { useState } from "react";

import { useStore } from "../../state/store";
import type { AiAuditEntry } from "../../types";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AiAuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AiAuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="history__item history__item--ai">
      <button
        className="history__item-head history__item-head--button"
        onClick={onToggle}
        title={expanded ? "Collapse" : "Show full prompt and tool calls"}
      >
        <span
          className={
            "history__status" + (entry.error ? " history__status--err" : " history__status--ok")
          }
        />
        <span className="history__time mono">{formatTime(entry.startedAt)}</span>
        <span className="history__meta mono">
          {entry.provider}/{entry.model} · {entry.toolCalls.length} tool
          {entry.toolCalls.length === 1 ? "" : "s"} · {entry.elapsedMs} ms
        </span>
      </button>
      <p className="history__ai-message">{entry.userMessage || "(empty message)"}</p>
      {entry.error && <span className="history__error mono">{entry.error}</span>}
      {expanded && (
        <div className="history__ai-detail">
          <div className="history__ai-section">
            <span className="history__ai-section-label">System prompt</span>
            <pre className="history__ai-pre">{entry.systemPrompt}</pre>
          </div>
          {entry.toolCalls.length > 0 && (
            <div className="history__ai-section">
              <span className="history__ai-section-label">Tool calls</span>
              {entry.toolCalls.map((call, i) => (
                <div key={i} className="history__ai-tool-call">
                  <div className="history__ai-tool-call-head mono">
                    <span>{call.tool}</span>
                    <span>{call.elapsedMs} ms</span>
                  </div>
                  <pre className="history__ai-pre">{JSON.stringify(call.input, null, 2)}</pre>
                  {call.error ? (
                    <span className="history__error mono">{call.error}</span>
                  ) : call.output !== null ? (
                    <pre className="history__ai-pre">{call.output}</pre>
                  ) : (
                    <span className="history__ai-redacted mono">
                      row data not logged{call.rowCount !== null ? ` — ${call.rowCount} rows` : ""}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="history__ai-section">
            <span className="history__ai-section-label">Reply</span>
            <pre className="history__ai-pre">{entry.reply || "(no reply)"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function AiAuditTab() {
  const entries = useStore((s) => s.aiAuditEntries);
  const enabled = useStore((s) => s.aiConfig?.auditLogEnabled ?? false);
  const setEnabled = useStore((s) => s.saveAiAuditLogEnabled);
  const [expanded, setExpanded] = useState<number | null>(null);

  if (!enabled) {
    return (
      <div className="history__ai-empty-state">
        <p className="history__empty">
          The AI audit log is off. Turn it on to keep a record of every AI turn — the full prompt
          the model saw and every tool it called — for this device.
        </p>
        <button className="history__ai-enable" onClick={() => void setEnabled(true)}>
          Turn on audit logging
        </button>
      </div>
    );
  }

  return (
    <div className="history__list">
      {entries.length === 0 && <p className="history__empty">No AI turns logged yet.</p>}
      {entries.map((entry, i) => (
        <AiAuditRow
          key={i}
          entry={entry}
          expanded={expanded === i}
          onToggle={() => setExpanded(expanded === i ? null : i)}
        />
      ))}
    </div>
  );
}

/** Slide-in panel with two tabs: recent queries (click one to re-run it in a
 *  new tab), and the AI audit log — full prompt/tool-call detail for AI
 *  turns, opt-in (see `AiConfigStatus.auditLogEnabled`). Both are "a log of
 *  things that happened here," sharing one entry point rather than each
 *  claiming their own toolbar icon. */
export function HistoryPanel() {
  const history = useStore((s) => s.history);
  const rerun = useStore((s) => s.rerunFromHistory);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const clearHistory = useStore((s) => s.clearHistory);
  const tab = useStore((s) => s.historyTab);
  const setTab = useStore((s) => s.setHistoryTab);
  const clearAiAuditLog = useStore((s) => s.clearAiAuditLog);
  const aiAuditCount = useStore((s) => s.aiAuditEntries.length);

  const onClear = tab === "queries" ? clearHistory : clearAiAuditLog;
  const clearVisible = tab === "queries" ? history.length > 0 : aiAuditCount > 0;

  return (
    <div className="history">
      <div className="history__head">
        <div className="history__tabs">
          <button
            className={"history__tab" + (tab === "queries" ? " history__tab--active" : "")}
            onClick={() => setTab("queries")}
          >
            Queries
          </button>
          <button
            className={"history__tab" + (tab === "ai" ? " history__tab--active" : "")}
            onClick={() => setTab("ai")}
          >
            AI
          </button>
        </div>
        <div className="history__head-actions">
          {clearVisible && (
            <button
              className="history__clear"
              onClick={() => void onClear()}
              title={tab === "queries" ? "Delete all history" : "Delete the AI audit log"}
            >
              Clear
            </button>
          )}
          <button className="history__close" onClick={toggleHistory} title="Close">
            ×
          </button>
        </div>
      </div>
      {tab === "queries" ? (
        <div className="history__list">
          {history.length === 0 && <p className="history__empty">No queries yet.</p>}
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
                    (entry.success ? " history__status--ok" : " history__status--err")
                  }
                />
                <span className="history__time mono">{formatTime(entry.executedAt)}</span>
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
      ) : (
        <AiAuditTab />
      )}
    </div>
  );
}
