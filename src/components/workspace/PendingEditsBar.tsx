import { useEffect, useRef, useState } from "react";

import type { QueryTab } from "../../state/store";
import { useStore } from "../../state/store";

/**
 * Footer bar that appears at the bottom of the results grid whenever a table
 * tab has unsaved cell edits — the "pending commit bar" from the design spec.
 * Amber-tinted so it reads as a distinct, temporary state; holds the change
 * count, any commit error (inline, never a modal), and the Discard / Update
 * actions. Cmd/Ctrl+S commits.
 */
export function PendingEditsBar({ tab }: { tab: QueryTab }) {
  const discardEdits = useStore((s) => s.discardEdits);
  const commitEdits = useStore((s) => s.commitEdits);
  const [committing, setCommitting] = useState(false);

  const editCount = tab.pendingEdits
    ? Object.values(tab.pendingEdits).reduce(
        (sum, row) => sum + Object.keys(row).length,
        0,
      )
    : 0;
  const newRowCount = tab.newRows?.length ?? 0;

  const summary = [
    editCount > 0
      ? `${editCount} ${editCount === 1 ? "change" : "changes"}`
      : null,
    newRowCount > 0
      ? `${newRowCount} new ${newRowCount === 1 ? "row" : "rows"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const commit = async () => {
    if (committing) return;
    setCommitting(true);
    try {
      await commitEdits(tab.id);
    } finally {
      setCommitting(false);
    }
  };

  // Keep a ref to the latest commit so the keydown listener (registered once)
  // always sees current `committing`/tab state rather than a stale closure.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void commitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pending-bar">
      <span className="pending-bar__count">
        <span className="pending-bar__dot" />
        {summary} unsaved
      </span>
      {tab.updateError && (
        <span className="pending-bar__error mono" title={tab.updateError.message}>
          {tab.updateError.message}
        </span>
      )}
      <div className="pending-bar__actions">
        <button
          className="pending-bar__discard"
          onClick={() => discardEdits(tab.id)}
          disabled={committing}
        >
          Discard
        </button>
        <button
          className="pending-bar__commit"
          onClick={() => void commit()}
          disabled={committing}
        >
          {committing ? "Updating…" : "Update"}
          <span className="pending-bar__kbd mono">⌘S</span>
        </button>
      </div>
    </div>
  );
}
