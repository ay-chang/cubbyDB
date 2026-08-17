import { useEffect, useState } from "react";

import { useActiveCubby, useConnectionCubbies, useStore } from "../../state/store";
import type { Cubby, CubbyEntry } from "../../types";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A short, human label for one entry — used by both the list preview and
 *  the expanded detail view. Saved-query names are looked up live so a
 *  rename elsewhere is reflected here without the cubby itself changing;
 *  everything else is self-describing from the reference alone. Chat
 *  entries don't resolve a title (the active connection's chat list isn't
 *  always loaded) — "AI chat" plus its open action is enough to use it. */
function entryLabel(entry: CubbyEntry, savedQueryName: (id: string) => string | null): string {
  switch (entry.kind) {
    case "savedQuery":
      return savedQueryName(entry.savedQueryId) ?? "(deleted saved query)";
    case "table":
      return `${entry.schema}.${entry.table}`;
    case "structure":
      return `${entry.schema}.${entry.table}`;
    case "function":
      return `${entry.schema}.${entry.name}()`;
    case "sequence":
      return `${entry.schema}.${entry.name}`;
    case "chat":
      return "AI chat";
  }
}

const ENTRY_KIND_LABEL: Record<CubbyEntry["kind"], string> = {
  savedQuery: "query",
  table: "table",
  structure: "structure",
  function: "function",
  sequence: "sequence",
  chat: "chat",
};

/** Slide-in panel listing this connection's cubbies. Click a name to open it
 *  (restores every entry's tab and pins its tables for the schema tree and
 *  AI); the chevron expands a row in place to review and prune its entries
 *  without touching the workspace. Same drawer treatment as
 *  History/Saved Queries/AI. */
export function CubbyPanel() {
  const cubbies = useConnectionCubbies();
  const activeCubby = useActiveCubby();
  const toggleCubbies = useStore((s) => s.toggleCubbies);
  const createCubby = useStore((s) => s.createCubby);
  const renameCubby = useStore((s) => s.renameCubby);
  const deleteCubbyById = useStore((s) => s.deleteCubbyById);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // A freshly-opened cubby (e.g. from "Add to cubby" elsewhere, or just
  // created) is the one thing worth auto-expanding — everything else stays
  // as the user left it.
  useEffect(() => {
    if (activeCubby) setExpandedId(activeCubby.id);
    // Only the id matters — re-running whenever the cubby record changes
    // (e.g. adding an entry) would fight the user's own expand/collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCubby?.id]);

  const startRename = (cubby: Cubby) => {
    setRenamingId(cubby.id);
    setRenameValue(cubby.name);
  };
  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (renamingId && trimmed) void renameCubby(renamingId, trimmed);
    setRenamingId(null);
  };

  const commitCreate = () => {
    const trimmed = newName.trim();
    setCreating(false);
    setNewName("");
    if (trimmed) void createCubby(trimmed);
  };

  return (
    <div className="cubby-panel">
      <div className="cubby-panel__head">
        <span className="caption">Cubbies</span>
        <div className="cubby-panel__head-actions">
          <button className="ai-panel__btn" onClick={() => setCreating(true)} title="New cubby">
            New
          </button>
          <button className="saved-queries__close" onClick={toggleCubbies} title="Close">
            ×
          </button>
        </div>
      </div>
      <div className="saved-queries__list">
        {creating && (
          <div className="cubby-panel__new">
            <input
              className="saved-queries__rename-input"
              value={newName}
              autoFocus
              placeholder="Cubby name"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
          </div>
        )}
        {cubbies.length === 0 && !creating && (
          <p className="saved-queries__empty">
            No cubbies yet for this connection. A cubby collects the tables,
            queries, and AI chats for one task so opening it brings
            everything back at once.
          </p>
        )}
        {cubbies.map((cubby) => {
          const isActive = activeCubby?.id === cubby.id;
          const isExpanded = expandedId === cubby.id;
          return (
            <div
              key={cubby.id}
              className={
                "saved-queries__item cubby-panel__item" +
                (isActive ? " cubby-panel__item--active" : "")
              }
            >
              <div className="cubby-panel__row">
                <span
                  className="cubby-panel__chevron"
                  onClick={() => setExpandedId(isExpanded ? null : cubby.id)}
                  title={isExpanded ? "Collapse" : "Show entries"}
                >
                  {isExpanded ? "▼" : "▶"}
                </span>
                <div
                  className="saved-queries__item-main"
                  onClick={() => setExpandedId(isExpanded ? null : cubby.id)}
                  title={isExpanded ? "Collapse" : "Show entries"}
                >
                  {renamingId === cubby.id ? (
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
                      <span className="saved-queries__name">
                        {cubby.name}
                        {isActive && <span className="cubby-panel__pin-tag">pinned</span>}
                      </span>
                      <span className="saved-queries__time mono">
                        {formatTime(cubby.updatedAt)}
                      </span>
                    </div>
                  )}
                  <span className="cubby-panel__count">
                    {cubby.entries.length} {cubby.entries.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="saved-queries__item-actions">
                  <span
                    className="saved-queries__rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(cubby);
                    }}
                    title="Rename"
                  >
                    ✎
                  </span>
                  <span
                    className="saved-queries__delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteCubbyById(cubby.id);
                    }}
                    title="Delete"
                  >
                    ×
                  </span>
                </div>
              </div>
              {isExpanded && <CubbyDetail cubby={cubby} isActive={isActive} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CubbyDetail({ cubby, isActive }: { cubby: Cubby; isActive: boolean }) {
  const savedQueries = useStore((s) => s.savedQueries);
  const openCubby = useStore((s) => s.openCubby);
  const closeCubby = useStore((s) => s.closeCubby);
  const removeEntryFromCubby = useStore((s) => s.removeEntryFromCubby);

  const savedQueryName = (id: string) => savedQueries.find((q) => q.id === id)?.name ?? null;

  return (
    <div className="cubby-panel__detail">
      <div className="cubby-panel__detail-title">{cubby.name}</div>

      <span className="cubby-panel__section-label">Entries</span>
      {cubby.entries.length === 0 ? (
        <p className="saved-queries__empty">
          Nothing yet — use "Add to cubby" on a table, saved query, or AI chat.
        </p>
      ) : (
        <div className="cubby-panel__entries">
          {cubby.entries.map((entry, i) => (
            <div className="cubby-panel__entry" key={i}>
              <span className="cubby-panel__entry-kind mono">{ENTRY_KIND_LABEL[entry.kind]}</span>
              <span className="cubby-panel__entry-label">{entryLabel(entry, savedQueryName)}</span>
              <span
                className="saved-queries__delete"
                onClick={() => void removeEntryFromCubby(cubby.id, entry)}
                title="Remove from cubby"
              >
                ×
              </span>
            </div>
          ))}
        </div>
      )}

      {isActive ? (
        <button className="btn btn--primary" onClick={closeCubby} title="Unpin without closing tabs">
          Close
        </button>
      ) : (
        <button
          className="btn btn--primary"
          onClick={() => void openCubby(cubby.id)}
          title="Restores every entry's tab"
        >
          Open
        </button>
      )}
    </div>
  );
}
