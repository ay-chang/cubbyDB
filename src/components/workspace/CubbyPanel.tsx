import { useEffect, useState } from "react";

import { useActiveCubby, useConnectionCubbies, useStore } from "../../state/store";
import type { Cubby, CubbyEntry } from "../../types";

function formatFull(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A short, human label for one entry. Saved-query names are looked up live
 *  so a rename elsewhere is reflected here without the cubby itself
 *  changing; everything else is self-describing from the reference alone.
 *  Chat entries don't resolve a title (the active connection's chat list
 *  isn't always loaded) — "AI chat" is enough to recognize it. */
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

/** Slide-in panel listing this connection's cubbies, one compact row each.
 *  Clicking a row opens that cubby straight away (restoring every entry's
 *  tab and pinning its tables for the schema tree and AI), or unpins it if
 *  it's already the active one — the chevron is a separate, non-committal
 *  way to peek at and prune its entries. Same drawer treatment as
 *  History/Saved Queries/AI. */
export function CubbyPanel() {
  const cubbies = useConnectionCubbies();
  const activeCubby = useActiveCubby();
  const toggleCubbies = useStore((s) => s.toggleCubbies);
  const createCubby = useStore((s) => s.createCubby);
  const renameCubby = useStore((s) => s.renameCubby);
  const deleteCubbyById = useStore((s) => s.deleteCubbyById);
  const openCubby = useStore((s) => s.openCubby);
  const closeCubby = useStore((s) => s.closeCubby);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // A just-created cubby is worth expanding once so its (empty) entry list
  // explains what to do next; everything else stays as the user left it.
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
      <div className="cubby-panel__list">
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
          const count = cubby.entries.length;
          return (
            <div
              key={cubby.id}
              className={"cubby-panel__item" + (isActive ? " cubby-panel__item--active" : "")}
            >
              <div className="cubby-panel__row">
                <span
                  className="cubby-panel__chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedId(isExpanded ? null : cubby.id);
                  }}
                  title={isExpanded ? "Hide entries" : "Show entries"}
                >
                  {isExpanded ? "▼" : "▶"}
                </span>
                <div
                  className="cubby-panel__main"
                  onClick={() => (isActive ? closeCubby() : void openCubby(cubby.id))}
                  title={`${count} ${count === 1 ? "entry" : "entries"} · updated ${formatFull(cubby.updatedAt)}`}
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
                    <>
                      <span className="cubby-panel__name">{cubby.name}</span>
                      {isActive && <span className="cubby-panel__pin-tag">pinned</span>}
                    </>
                  )}
                </div>
                <button
                  className={
                    "cubby-panel__open" + (isActive ? " cubby-panel__open--active" : "")
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isActive) closeCubby();
                    else void openCubby(cubby.id);
                  }}
                  title={
                    isActive
                      ? "Unpin this cubby — open tabs are left alone"
                      : "Restore every entry's tab"
                  }
                >
                  {isActive ? "Close" : "Open"}
                </button>
                <div className="cubby-panel__actions">
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
              {isExpanded && <CubbyEntries cubby={cubby} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CubbyEntries({ cubby }: { cubby: Cubby }) {
  const savedQueries = useStore((s) => s.savedQueries);
  const removeEntryFromCubby = useStore((s) => s.removeEntryFromCubby);

  const savedQueryName = (id: string) => savedQueries.find((q) => q.id === id)?.name ?? null;

  if (cubby.entries.length === 0) {
    return (
      <p className="cubby-panel__empty">
        Nothing yet — use "Add to cubby" on a table, saved query, or AI chat.
      </p>
    );
  }

  return (
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
  );
}
