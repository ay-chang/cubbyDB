import { useState } from "react";

import { useStore } from "../../state/store";
import type { SavedQuery } from "../../types";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Slide-in panel listing saved queries; click one to open it (or focus its
 *  already-open tab). Each item has inline rename and delete. */
export function SavedQueriesPanel() {
  const savedQueries = useStore((s) => s.savedQueries);
  const openSavedQuery = useStore((s) => s.openSavedQuery);
  const renameSavedQuery = useStore((s) => s.renameSavedQuery);
  const deleteSavedQueryById = useStore((s) => s.deleteSavedQueryById);
  const toggleSavedQueries = useStore((s) => s.toggleSavedQueries);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (query: SavedQuery) => {
    setRenamingId(query.id);
    setRenameValue(query.name);
  };
  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (renamingId && trimmed) void renameSavedQuery(renamingId, trimmed);
    setRenamingId(null);
  };

  return (
    <div className="saved-queries">
      <div className="saved-queries__head">
        <span className="caption">Saved queries</span>
        <button className="saved-queries__close" onClick={toggleSavedQueries} title="Close">
          ×
        </button>
      </div>
      <div className="saved-queries__list">
        {savedQueries.length === 0 && (
          <p className="saved-queries__empty">
            No saved queries yet. Save a query tab with Cmd/Ctrl+S.
          </p>
        )}
        {savedQueries.map((query) => (
          <div key={query.id} className="saved-queries__item">
            <div
              className="saved-queries__item-main"
              onClick={() => void openSavedQuery(query)}
              title="Open in a new tab"
            >
              {renamingId === query.id ? (
                <input
                  className="saved-queries__rename-input"
                  value={renameValue}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <div className="saved-queries__item-head">
                  <span className="saved-queries__name">{query.name}</span>
                  <span className="saved-queries__time mono">
                    {formatTime(query.createdAt)}
                  </span>
                </div>
              )}
              <code className="saved-queries__sql">{query.sql.trim()}</code>
            </div>
            <div className="saved-queries__item-actions">
              <span
                className="saved-queries__rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(query);
                }}
                title="Rename"
              >
                ✎
              </span>
              <span
                className="saved-queries__delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteSavedQueryById(query.id);
                }}
                title="Delete"
              >
                ×
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
