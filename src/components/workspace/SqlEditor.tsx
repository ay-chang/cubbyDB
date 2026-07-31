import { acceptCompletion } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";

import { buildSqlNamespace, SQL_KEYWORDS, sqlLanguage } from "../../lib/sqlSchema";
import { statementAt } from "../../lib/sqlStatements";
import { useActiveSchema, useStore } from "../../state/store";
import { cubbyEditorTheme } from "./editorTheme";
import { singleQuoteKeymap } from "./smartQuotes";

/**
 * The SQL editor for one tab. CodeMirror 6 with Postgres dialect highlighting
 * and schema-aware autocomplete (table names after FROM/JOIN, column names
 * after `alias.`, sourced from the active connection's live schema tree).
 * Cmd/Ctrl+Enter runs the selection (if any) or the statement under the
 * cursor; Cmd/Ctrl+Shift+Enter always runs the whole buffer; Cmd/Ctrl+Shift+E
 * runs EXPLAIN and Cmd/Ctrl+Shift+A runs EXPLAIN ANALYZE on the same
 * selection-or-statement target as Cmd/Ctrl+Enter; Tab accepts the
 * highlighted completion when the autocomplete popup is open.
 */
export function SqlEditor(props: {
  value: string;
  onChange: (value: string) => void;
  /** Run the given SQL text (a statement, a selection, or the whole buffer —
   *  never the tab's own `sql`, which the caller keeps unchanged). */
  onRun: (sql: string) => void;
}) {
  // Keep the run handler in a ref so the keymap extension is stable across
  // renders but always calls the latest handler.
  const runRef = useRef(props.onRun);
  runRef.current = props.onRun;

  const lineWrap = useStore((s) => s.editorLineWrap);
  const schema = useActiveSchema();
  const sqlNamespace = useMemo(() => buildSqlNamespace(schema), [schema]);
  // A default (unqualified) schema only makes sense to guess when there's
  // exactly one — with several, FROM/JOIN + alias resolution still works,
  // just without a bare "table name with no schema prefix" shortcut.
  const defaultSchema = schema.length === 1 ? schema[0].name : undefined;

  const extensions = useMemo(
    () => [
      sqlLanguage(sqlNamespace, defaultSchema, undefined, SQL_KEYWORDS),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: (view) => {
              runRef.current(selectionOrStatement(view));
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            preventDefault: true,
            run: (view) => {
              runRef.current(view.state.doc.toString());
              return true;
            },
          },
          {
            key: "Mod-Shift-e",
            preventDefault: true,
            run: (view) => {
              runRef.current(`EXPLAIN ${selectionOrStatement(view)}`);
              return true;
            },
          },
          {
            key: "Mod-Shift-a",
            preventDefault: true,
            run: (view) => {
              runRef.current(`EXPLAIN ANALYZE ${selectionOrStatement(view)}`);
              return true;
            },
          },
          // Falls through (returns false) to normal Tab behavior when no
          // completion popup is open.
          { key: "Tab", run: acceptCompletion },
          ...singleQuoteKeymap,
        ]),
      ),
      cubbyEditorTheme,
      ...(lineWrap ? [EditorView.lineWrapping] : []),
    ],
    [lineWrap, sqlNamespace, defaultSchema],
  );

  return (
    <div className="editor">
      <CodeMirror
        value={props.value}
        onChange={props.onChange}
        extensions={extensions}
        // "none" disables the library's built-in light theme, which would
        // otherwise paint a white background over our token-driven theme.
        // `cubbyEditorTheme` supplies every color via CSS variables, so the
        // editor follows light/dark automatically.
        theme="none"
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          autocompletion: true,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          bracketMatching: true,
          indentOnInput: false,
          // See the identical note in FilterBar.tsx: CodeMirror's own
          // find-in-text panel is unused here, but its default keymap
          // silently claims Mod-F/Mod-G, colliding with the results grid's
          // Find (Cmd+F) and jump-to-column (Cmd+G) whenever this editor
          // has focus.
          searchKeymap: false,
        }}
        height="100%"
        spellCheck={false}
      />
    </div>
  );
}

/** The SQL statement surrounding `pos`, or the whole buffer if the script has
 *  no statements at all (e.g. it's empty or only whitespace/comments). */
function sliceStatementAtCursor(doc: string, pos: number): string {
  const stmt = statementAt(doc, pos);
  return stmt ? doc.slice(stmt.start, stmt.end) : doc;
}

/** The current selection, or the statement under the cursor when nothing is
 *  selected — the shared target for Mod-Enter, Mod-Shift-E, Mod-Shift-A. */
function selectionOrStatement(view: EditorView): string {
  const sel = view.state.selection.main;
  return !sel.empty
    ? view.state.sliceDoc(sel.from, sel.to)
    : sliceStatementAtCursor(view.state.doc.toString(), sel.from);
}
