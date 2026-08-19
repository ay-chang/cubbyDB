import { acceptCompletion } from "@codemirror/autocomplete";
import { syntaxHighlighting } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../../api/backend";
import { aiProviderLabel, aiProviderReady } from "../../lib/aiProvider";
import { buildTableNamespace, WHERE_KEYWORDS, sqlLanguage } from "../../lib/sqlSchema";
import { Spinner } from "../common/Spinner";
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

/** The one thing the applied predicate can't say for itself, floated under
 *  the bar until dismissed: an assumption the AI made ("Interpreted 'last
 *  year' as calendar year 2025"), why it declined, or why the request never
 *  completed. Only `error` is styled as a failure — a decline is a real
 *  answer, just not a filter. Nothing shows when the predicate speaks for
 *  itself, which is the common case. */
type AiOutcome = { kind: "note" | "error"; text: string };

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
 *
 * The same bar also has an AI mode (the ✨ toggle, or Cmd/Ctrl+I from the
 * field): describe the rows instead of writing the predicate, and the
 * assistant — same provider, key, and model as the chat panel — writes it.
 * It's a mode rather than a separate control because the two are alternative
 * ways of saying one thing, and what AI mode produces is exactly what SQL
 * mode accepts: the predicate lands in `tab.filter` like any other, stays
 * editable by hand, and "Edit as SQL" hands it straight back to the editor.
 */
export function FilterBar({ tab }: { tab: QueryTab }) {
  const setTableFilter = useStore((s) => s.setTableFilter);
  const generateTableFilter = useStore((s) => s.generateTableFilter);
  const aiMode = useStore((s) => s.filterAiMode);
  const setFilterAiMode = useStore((s) => s.setFilterAiMode);
  const aiConfig = useStore((s) => s.aiConfig);
  const openSettings = useStore((s) => s.openSettings);
  const schema = useActiveSchema();
  const [draft, setDraft] = useState(tab.filter ?? "");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [outcome, setOutcome] = useState<AiOutcome | null>(null);
  const promptRef = useRef<HTMLInputElement>(null);
  const aiReady = aiProviderReady(aiConfig);

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

  // Same indirection as `applyRef`: the CodeMirror keymap below is built once
  // per schema/table, so it can't close over a handler that changes every
  // render.
  const enterAiModeRef = useRef<() => void>(() => {});

  const clear = () => {
    setDraft("");
    setPrompt("");
    setOutcome(null);
    void setTableFilter(tab.id, "");
  };

  const dirty = (tab.filter ?? "") !== draft.trim();

  /** Enter AI mode and put the cursor in the prompt field, so the toggle is
   *  one action rather than a click followed by a click. */
  const enterAiMode = () => {
    setFilterAiMode(true);
    requestAnimationFrame(() => promptRef.current?.focus());
  };
  enterAiModeRef.current = enterAiMode;

  /** Leave AI mode with whatever the AI produced still in the bar — `draft`
   *  already mirrors `tab.filter` (see the effect above), so the predicate is
   *  sitting in the SQL editor ready to be edited. */
  const leaveAiMode = () => {
    setFilterAiMode(false);
    setOutcome(null);
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating || !aiReady) return;
    setGenerating(true);
    setOutcome(null);
    try {
      const result = await generateTableFilter(tab.id, text);
      const where = result.whereClause.trim();
      if (where) {
        // Hand the answer back to the WHERE field and step out of the way:
        // the predicate the store just applied is what the user actually
        // works with next — reading it, tweaking a value, clearing it — and
        // that's the SQL field's job. AI mode is the asking, not a place to
        // stay. `draft` picks the predicate up from `tab.filter` on its own.
        setPrompt("");
        setFilterAiMode(false);
        setOutcome(result.note ? { kind: "note", text: result.note } : null);
      } else {
        // Nothing was applied and the table is untouched, so stay put with
        // the request still in the field — rewording it is the next move.
        setOutcome({
          kind: "note",
          text: result.note ?? "The AI couldn't turn that into a filter on this table.",
        });
      }
    } catch (err) {
      setOutcome({ kind: "error", text: errorMessage(err) });
    } finally {
      setGenerating(false);
    }
  };

  // Scoped to just this table's own columns — never the whole schema (see
  // `buildTableNamespace`'s doc comment for why that matters for large
  // schemas, not just tidiness).
  const sqlNamespace = useMemo(
    () =>
      tab.source
        ? buildTableNamespace(schema, tab.source.schema, tab.source.table)
        : {},
    [schema, tab.source],
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
          // Handled inside the editor rather than as an app-level keybinding
          // (see `lib/keybindings.ts`): it only ever means anything while
          // this one field has focus, and a registry entry would claim
          // Cmd+I everywhere for it. The AI-mode input has the matching
          // handler for the way back.
          {
            key: "Mod-i",
            preventDefault: true,
            run: () => {
              enterAiModeRef.current();
              return true;
            },
          },
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
    // `tab.source?.schema` isn't read directly here — only `sqlNamespace`
    // (itself already keyed on it) and `tab.source?.table` are.
    [sqlNamespace, tab.source?.table],
  );

  return (
    <div className={"filter-bar" + (aiMode ? " filter-bar--ai" : "")}>
      <span className="filter-bar__kw mono">{aiMode ? "ASK AI" : "WHERE"}</span>
      <div className="filter-bar__input-wrap">
        <div className="filter-bar__input">
          <button
            className={
              "filter-bar__ai-toggle" + (aiMode ? " filter-bar__ai-toggle--on" : "")
            }
            onClick={aiMode ? leaveAiMode : enterAiMode}
            title={
              aiMode
                ? "Back to writing SQL (⌘I)"
                : "AI mode — describe the rows you want instead (⌘I)"
            }
            aria-pressed={aiMode}
            aria-label="Toggle AI mode"
          >
            <SparkleIcon />
          </button>
          {aiMode ? (
            <input
              ref={promptRef}
              className="filter-bar__prompt"
              value={prompt}
              disabled={generating || !aiReady}
              spellCheck={false}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void generate();
                } else if (e.key === "Escape" && outcome) {
                  // Dismiss the result strip first; a second Escape falls
                  // through to whatever the workspace does with it.
                  e.preventDefault();
                  setOutcome(null);
                } else if (e.key === "i" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  leaveAiMode();
                }
              }}
            />
          ) : (
            <CodeMirror
              className="filter-bar__editor"
              value={draft}
              // Editing the predicate by hand answers the note — it's about
              // a predicate that no longer exists as written.
              onChange={(value) => {
                setDraft(value);
                setOutcome(null);
              }}
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
          )}
        </div>
        {(tab.filter || draft || prompt) && (
          <button
            className="filter-bar__clear"
            onClick={clear}
            title="Clear filter"
          >
            ×
          </button>
        )}
        {/* Outlives AI mode by design: a successful generation hands the
            predicate back to the WHERE field, and the note explaining it has
            to still be there when it lands. */}
        {outcome && (
          <div className={"filter-note filter-note--" + outcome.kind}>
            <span className="filter-note__text" title={outcome.text}>
              {outcome.text}
            </span>
            <button
              className="filter-note__close"
              onClick={() => setOutcome(null)}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {aiMode && !aiReady && !outcome && (
          <div className="filter-note filter-note--note">
            <span className="filter-note__text">
              AI mode needs {aiProviderLabel(aiConfig)} set up.{" "}
              <span
                className="filter-note__link"
                onClick={() => openSettings("aiAssistant")}
              >
                Open Settings
              </span>
            </span>
          </div>
        )}
      </div>
      {aiMode ? (
        <button
          className="filter-bar__apply"
          onClick={() => void generate()}
          disabled={!prompt.trim() || generating || !aiReady}
          title="Write the filter with AI"
        >
          {generating ? (
            <>
              <Spinner light /> Writing…
            </>
          ) : (
            <>
              Generate <span className="filter-bar__kbd mono">↵</span>
            </>
          )}
        </button>
      ) : (
        <button
          className="filter-bar__apply"
          onClick={() => applyRef.current()}
          disabled={!dirty}
          title="Apply filter"
        >
          Apply <span className="filter-bar__kbd mono">↵</span>
        </button>
      )}
    </div>
  );
}

/** The AI-mode toggle's glyph — a four-point sparkle, the same shorthand the
 *  rest of the app uses for "the assistant did this". */
function SparkleIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </svg>
  );
}
