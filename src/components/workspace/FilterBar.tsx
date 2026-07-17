import { useState } from "react";

import type { QueryTab } from "../../state/store";
import { useStore } from "../../state/store";

/**
 * The table-browser filter bar. Always prefixed with a fixed `WHERE`; the user
 * types a predicate (e.g. `id = '1234'`) and presses Enter to apply. The
 * predicate is sent to the backend, which rebuilds the table query with it —
 * the frontend never assembles the SQL itself. Mount with `key={tab.id}` so the
 * draft resets when switching tabs.
 */
export function FilterBar({ tab }: { tab: QueryTab }) {
  const setTableFilter = useStore((s) => s.setTableFilter);
  const [draft, setDraft] = useState(tab.filter ?? "");

  const apply = () => void setTableFilter(tab.id, draft);
  const clear = () => {
    setDraft("");
    void setTableFilter(tab.id, "");
  };

  const dirty = (tab.filter ?? "") !== draft.trim();

  return (
    <div className="filter-bar">
      <span className="filter-bar__kw mono">WHERE</span>
      <input
        className="filter-bar__input mono"
        value={draft}
        placeholder="id = '1234'"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {(tab.filter || draft) && (
        <button className="filter-bar__clear" onClick={clear} title="Clear filter">
          Clear
        </button>
      )}
      <button
        className="filter-bar__apply"
        onClick={apply}
        disabled={!dirty}
        title="Apply filter"
      >
        Apply <span className="filter-bar__kbd mono">↵</span>
      </button>
    </div>
  );
}
