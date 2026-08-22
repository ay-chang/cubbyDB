import { useEffect, useRef, useState } from "react";

import { useStore } from "../../state/store";
import { buildTableAndColumnItems } from "./commandPaletteItems";

/**
 * Small anchored popover for the AI panel's "+" button: search the current
 * connection's tables and attach one as AI context. Reuses the same
 * fuzzy-search core the Cmd+K command palette uses (`buildTableAndColumnItems`)
 * rather than duplicating table-search logic, just scoped to one connection
 * and tables only (no columns, no other item kinds).
 */
export function AiTablePicker({
  onPick,
  onClose,
}: {
  onPick: (schema: string, table: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const slot = useStore((s) => (s.activeConnectionId ? s.connections[s.activeConnectionId] : null));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);

  if (!slot || !activeConnectionId) return null;

  const { tables } = buildTableAndColumnItems([slot], activeConnectionId, query, true, false);

  return (
    <div className="ai-table-picker" ref={rootRef}>
      <input
        ref={inputRef}
        className="ai-table-picker__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Attach a table…"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="ai-table-picker__list">
        {tables.length === 0 ? (
          <div className="ai-table-picker__empty">No matching tables.</div>
        ) : (
          tables.map((item) => {
            if (item.kind !== "table") return null;
            return (
              <button
                key={item.id}
                type="button"
                className="ai-table-picker__item"
                onClick={() => onPick(item.schema, item.table)}
              >
                <span className="mono">
                  {item.schema}.{item.table}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
