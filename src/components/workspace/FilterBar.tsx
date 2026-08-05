import { acceptCompletion } from "@codemirror/autocomplete";
import { syntaxHighlighting } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

import { buildTableNamespace, WHERE_KEYWORDS, sqlLanguage } from "../../lib/sqlSchema";
import type { QueryTab } from "../../state/store";
import { useActiveSchema, useStore } from "../../state/store";
import {
  cubbyAutocompleteTheme,
  cubbySelectionTheme,
  sqlHighlightStyle,
} from "./editorTheme";
import { singleQuoteKeymap } from "./smartQuotes";

/** Compact single-line theme — the box styling (border, height, padding)
 *  comes from the `.filter-bar__input` wrapper div; this just makes
 *  CodeMirror's own chrome disappear into it. */
const filterEditorTheme = EditorView.theme({
  "&": { fontSize: "12.5px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "hidden" },
  // A couple px of padding on *both* sides, not just the right — with
  // `overflow: hidden` above, a cursor sitting exactly at the start or end
  // of the text has no room to render and gets clipped, invisibly, since
  // neither typing nor arrowing back to it depends on the cursor being
  // visible. The cursor's own CSS (CodeMirror's base theme) gives it a
  // `margin-left: -0.6px` to center it on the character boundary, so even
  // position 0 — no left padding at all — pokes just past `.cm-content`'s
  // own edge into the clipped zone. Originally only the right side carried
  // this buffer (CodeMirror's own base theme reserves the same one there),
  // which fixed the end-of-text case but left position 0 clipped exactly
  // the same way.
  // Four vertical pixels center the 1.4-line-height text inside the field's
  // 26px inner box; the asymmetric horizontal padding preserves the caret
  // breathing room described above.
  ".cm-content": { padding: "4px 3px 4px 2px", caretColor: "var(--accent)" },
  ".cm-line": { padding: 0 },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  // CodeMirror's own base theme hides `.cm-cursor` by default and only shows
  // it via `&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor` — a
  // selector that requires `.cm-scroller` to be a *direct* child of the
  // focused `.cm-editor` root. That held for the multi-line SQL editor, but
  // this compact single-line instance never matched it (the caret was there
  // the whole time, just permanently `display: none`d) — typing worked fine
  // since that never depended on the cursor being visible. A broader
  // descendant selector (`.cm-focused .cm-cursor`, no `>`) still only
  // matches while actually focused, so it hides again on blur exactly like
  // the original, just without depending on that exact nesting.
  "&.cm-focused .cm-cursor": { display: "block" },
  // Selection colors come from the shared `cubbySelectionTheme` below — see
  // its comment for why they can't just be set here.
});

/**
 * The table-browser filter bar. Always prefixed with a fixed `WHERE`; the user
 * types a predicate (e.g. `id = '1234'`) and presses Enter to apply. The
 * predicate is sent to the backend, which rebuilds the table query with it —
 * the frontend never assembles the SQL itself. Mount with `key={tab.id}` so the
 * draft resets when switching tabs.
 *
 * A single-line CodeMirror instance rather than a plain `<input>`, so it gets
 * the same schema-aware autocomplete as the SQL editor — scoped to just this
 * tab's own table (`defaultTable`), so a bare column name completes directly
 * with no alias needed, since there's only ever one table in scope here.
 */
export function FilterBar({ tab }: { tab: QueryTab }) {
  const setTableFilter = useStore((s) => s.setTableFilter);
  const schema = useActiveSchema();
  const [draft, setDraft] = useState(tab.filter ?? "");

  // `tab.filter` can change out from under this component without a remount
  // — e.g. FK navigation (`openTableWithFilter`) landing on a table that
  // already has a tab open reuses that tab rather than creating a new one,
  // so `key={tab.id}` in ResultsPane doesn't reset the local draft. Without
  // this, the grid would re-run with the new filter while the bar kept
  // showing whatever was typed here last.
  useEffect(() => {
    setDraft(tab.filter ?? "");
  }, [tab.filter]);

  const applyRef = useRef<() => void>(() => {});
  applyRef.current = () => void setTableFilter(tab.id, draft);

  const clear = () => {
    setDraft("");
    void setTableFilter(tab.id, "");
  };

  const dirty = (tab.filter ?? "") !== draft.trim();

  // Scoped to just this table's own columns — never the whole schema (see
  // `buildTableNamespace`'s doc comment for why that matters for large
  // schemas, not just tidiness).
  const sqlNamespace = useMemo(
    () =>
      tab.source
        ? buildTableNamespace(schema, tab.source.schema, tab.source.table)
        : {},
    [schema, tab.source?.schema, tab.source?.table],
  );
  const extensions = useMemo(
    () => [
      sqlLanguage(sqlNamespace, undefined, tab.source?.table, WHERE_KEYWORDS),
      Prec.highest(
        keymap.of([
          {
            key: "Enter",
            preventDefault: true,
            // Enter accepts an open completion first (standard editor
            // behavior); only applies the filter once nothing's open.
            run: (view) => {
              if (acceptCompletion(view)) return true;
              applyRef.current();
              return true;
            },
          },
          { key: "Tab", run: acceptCompletion },
          ...singleQuoteKeymap,
        ]),
      ),
      filterEditorTheme,
      cubbySelectionTheme,
      cubbyAutocompleteTheme,
      syntaxHighlighting(sqlHighlightStyle),
      // The placeholder widget (below) appears the instant the doc empties,
      // but CodeMirror doesn't reliably remeasure the cursor layer against
      // the widget's own width in that same paint — leaving the cursor
      // rendered at wherever it was *before* the clear (e.g. after clearing
      // "test", the cursor stays 4 characters in) until something else
      // nudges a relayout. A one-off requestMeasure() on exactly that
      // transition is that nudge.
      EditorView.updateListener.of((update) => {
        if (update.docChanged && update.state.doc.length === 0) {
          requestAnimationFrame(() => update.view.requestMeasure());
        }
      }),
      // The cursor's `drawSelection` layer only ever redraws itself in
      // response to an actual transaction that changes the doc, the
      // selection, or the geometry (`cursorLayer.update` in CodeMirror's own
      // source gates on exactly those three) — a bare DOM focus event isn't
      // one of those, so `view.requestMeasure()` on focus (a prior attempt
      // at this fix) never actually re-triggered that layer, only the
      // view's own generic measure pass. This editor mounts (and does its
      // one and only unforced draw) inside a header that's still settling
      // its final flex layout in that same paint, so that first draw
      // computes an empty/invalid cursor rect and never gets revisited —
      // typing happens to work because *that* is a real doc-changing
      // transaction. Re-dispatching the current selection on focus is a
      // no-op to the document but *is* a real transaction, so it forces the
      // same redraw typing does, now that the field is actually laid out.
      EditorView.domEventHandlers({
        focus: (_event, view) => {
          view.dispatch({ selection: view.state.selection });
        },
      }),
    ],
    [sqlNamespace, tab.source?.schema, tab.source?.table],
  );

  return (
    <div className="filter-bar">
      <span className="filter-bar__kw mono">WHERE</span>
      <div className="filter-bar__input-wrap">
        <div className="filter-bar__input">
          <CodeMirror
            className="filter-bar__editor"
            value={draft}
            onChange={setDraft}
            extensions={extensions}
            theme="none"
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              autocompletion: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              bracketMatching: false,
              closeBrackets: true,
              indentOnInput: false,
              // CodeMirror's own find-in-text panel — unused here (nothing
              // in this app opens it deliberately) but its default keymap
              // silently claims Mod-F/Mod-G, colliding with the grid's own
              // Find (Cmd+F) and jump-to-column (Cmd+G) shortcuts whenever
              // this editor happens to have focus.
              searchKeymap: false,
            }}
            placeholder="id = '1234'"
            spellCheck={false}
          />
        </div>
        {(tab.filter || draft) && (
          <button
            className="filter-bar__clear"
            onClick={clear}
            title="Clear filter"
          >
            ×
          </button>
        )}
      </div>
      <button
        className="filter-bar__apply"
        onClick={() => applyRef.current()}
        disabled={!dirty}
        title="Apply filter"
      >
        Apply <span className="filter-bar__kbd mono">↵</span>
      </button>
    </div>
  );
}
