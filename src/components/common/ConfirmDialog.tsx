import { useStore } from "../../state/store";

/**
 * The one deliberate exception to "errors are always inline, never modal" in
 * this app: confirming a data-loss action (leaving, closing, or refreshing a
 * table tab with unsaved cell edits) is a decision, not an error, and blocking
 * on it is the expected, safest default — matching how browsers and editors
 * warn before discarding unsaved changes.
 */
export function ConfirmDialog() {
  const dialog = useStore((s) => s.confirmDialog);
  if (!dialog) return null;

  return (
    <div className="confirm-overlay" onClick={dialog.onCancel}>
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <span className="confirm-card__message">{dialog.message}</span>
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
