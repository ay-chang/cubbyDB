import { useState } from "react";

import { useActiveTabId, useActiveTabs, useStore } from "../../state/store";

/**
 * Small overlay for saving the active query tab as a named "Saved Query" —
 * the same Update/Save-as-new split `ConnectionScreen` uses for saved
 * connections, so a tab already linked to a saved query can either overwrite
 * it or branch off a new one, and it's always explicit which one you're
 * about to do.
 */
export function SaveQueryDialog({ onClose }: { onClose: () => void }) {
  const activeTabId = useActiveTabId();
  const tabs = useActiveTabs();
  const tab = tabs.find((t) => t.id === activeTabId) ?? null;
  const savedQueries = useStore((s) => s.savedQueries);
  const saveTabAsQuery = useStore((s) => s.saveTabAsQuery);

  const linkedQuery = tab?.savedQueryId
    ? savedQueries.find((q) => q.id === tab.savedQueryId) ?? null
    : null;
  const [name, setName] = useState(linkedQuery?.name ?? tab?.title ?? "");
  const [saving, setSaving] = useState(false);

  if (!tab) return null;

  const handleSave = (mode: "update" | "new") => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    void saveTabAsQuery(tab.id, trimmed, mode).then(onClose);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="add-connection-card"
        role="dialog"
        aria-modal="true"
        aria-label="Save query"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__head">
          <span className="settings-panel__title">Save query</span>
          <button className="settings-panel__close" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>
        <form
          className="conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave(linkedQuery ? "update" : "new");
          }}
        >
          <label className="conn-field">
            <span className="caption">Name</span>
            <input
              className="conn-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Query name"
              autoFocus
              spellCheck={false}
            />
          </label>
          <div className="conn-actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!name.trim() || saving}
              title={linkedQuery ? `Overwrite "${linkedQuery.name}" with this SQL` : "Save this query"}
            >
              {linkedQuery ? "Update" : "Save"}
            </button>
            {linkedQuery && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => handleSave("new")}
                disabled={!name.trim() || saving}
                title="Save these values as a new query, leaving the original unchanged"
              >
                Save as new
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
