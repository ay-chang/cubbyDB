import { useState } from "react";

import { useStore } from "../../state/store";

/** How much of a long statement list is shown before "Show more". Five lines
 *  is enough to recognize what the script does without the dialog growing
 *  into a wall of SQL the moment it opens. */
const COLLAPSED_LINES = 5;

/**
 * The one deliberate exception to "errors are always inline, never modal" in
 * this app: confirming a data-loss action (leaving, closing, or refreshing a
 * table tab with unsaved cell edits; running a statement that deletes rows or
 * drops an object) is a decision, not an error, and blocking on it is the
 * expected, safest default — matching how browsers and editors warn before
 * discarding unsaved changes.
 *
 * `details`, when present, is SQL: the statements the user is being asked
 * about, rendered as a code block so they can actually be read. A
 * confirmation about specific statements that does not show them is just an
 * obstacle.
 */
export function ConfirmDialog() {
  const dialog = useStore((s) => s.confirmDialog);
  // Which dialog the user expanded, rather than a bare boolean: this
  // component stays mounted between confirmations, and identity comparison
  // means the next one opens collapsed without needing an effect to reset it.
  const [expandedFor, setExpandedFor] = useState<object | null>(null);

  if (!dialog) return null;

  const details = dialog.details ?? [];
  const collapsible = details.length > COLLAPSED_LINES;
  const expanded = expandedFor === dialog;
  const shown = collapsible && !expanded ? details.slice(0, COLLAPSED_LINES) : details;

  return (
    <div className="confirm-overlay" onClick={dialog.onCancel}>
      <div
        className={`confirm-card${details.length > 0 ? " confirm-card--code" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="confirm-card__message">{dialog.message}</span>
        {details.length > 0 && (
          <div className="confirm-card__code-group">
            <pre className="confirm-card__code">
              <code>{shown.join("\n")}</code>
            </pre>
            {collapsible && (
              <button
                className="confirm-card__more"
                onClick={() => setExpandedFor(expanded ? null : dialog)}
              >
                {expanded ? "Show less" : `Show ${details.length - COLLAPSED_LINES} more`}
              </button>
            )}
          </div>
        )}
        <div className="confirm-card__actions">
          <button className="btn btn--outline" onClick={dialog.onCancel}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={dialog.onConfirm}>
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
