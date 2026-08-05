import { acceptCompletion } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useMemo, useRef } from "react";

import {
  bindingToCodeMirror,
  formatShortcutTitle,
  useKeybindingStore,
} from "../../lib/keybindings";
import { buildSqlNamespace, SQL_KEYWORDS, sqlLanguage } from "../../lib/sqlSchema";
import { statementAt } from "../../lib/sqlStatements";
import { useActiveSchema, useStore } from "../../state/store";
import { cubbyEditorTheme } from "./editorTheme";
import { singleQuoteKeymap } from "./smartQuotes";

/**
 * The SQL editor for one tab. CodeMirror 6 with Postgres dialect highlighting
 * and schema-aware autocomplete (table names after FROM/JOIN, column names
 * after `alias.`, sourced from the active connection's live schema tree).
 * The configurable query shortcuts run the selection/statement, whole buffer,
 * EXPLAIN, or EXPLAIN ANALYZE. Tab accepts the highlighted completion when the
 * autocomplete popup is open.
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

  // The live view, captured once on mount, so the toolbar Run button can
  // target the same selection-or-statement the Mod-Enter keymap uses without
  // needing the editor focused.
  const viewRef = useRef<EditorView | null>(null);
  const onCreateEditor = useCallback((view: EditorView) => {
    viewRef.current = view;
  }, []);
  const handleRunClick = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    runRef.current(selectionOrStatement(view));
  }, []);

  const lineWrap = useStore((s) => s.editorLineWrap);
  const bindings = useKeybindingStore((s) => s.bindings);
  const schema = useActiveSchema();
  const sqlNamespace = useMemo(() => buildSqlNamespace(schema), [schema]);
  // A default (unqualified) schema only makes sense to guess when there's
  // exactly one — with several, FROM/JOIN + alias resolution still works,
  // just without a bare "table name with no schema prefix" shortcut.
  const defaultSchema = schema.length === 1 ? schema[0].name : undefined;

  const queryKeymap = useMemo(() => {
    const commands = [
      {
        binding: bindings["query.run"],
        run: (view: EditorView) => runRef.current(selectionOrStatement(view)),
      },
      {
        binding: bindings["query.runAll"],
        run: (view: EditorView) => runRef.current(view.state.doc.toString()),
      },
      {
        binding: bindings["query.explain"],
        run: (view: EditorView) =>
          runRef.current(`EXPLAIN ${selectionOrStatement(view)}`),
      },
      {
        binding: bindings["query.explainAnalyze"],
        run: (view: EditorView) =>
          runRef.current(`EXPLAIN ANALYZE ${selectionOrStatement(view)}`),
      },
    ];

    return commands.flatMap(({ binding, run }) => {
      const key = bindingToCodeMirror(binding);
      return key
        ? [{ key, preventDefault: true, run: (view: EditorView) => (run(view), true) }]
        : [];
    });
  }, [bindings]);

  const extensions = useMemo(
    () => [
      sqlLanguage(sqlNamespace, defaultSchema, undefined, SQL_KEYWORDS, schema),
      Prec.highest(
        keymap.of([
          ...queryKeymap,
          // Falls through (returns false) to normal Tab behavior when no
          // completion popup is open.
          { key: "Tab", run: acceptCompletion },
          ...singleQuoteKeymap,
        ]),
      ),
      cubbyEditorTheme,
      ...(lineWrap ? [EditorView.lineWrapping] : []),
    ],
    [lineWrap, sqlNamespace, defaultSchema, schema, queryKeymap],
  );

  return (
    <div className="editor">
      <CodeMirror
        value={props.value}
        onChange={props.onChange}
        onCreateEditor={onCreateEditor}
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
      <button
        className="editor__run-btn"
        title={formatShortcutTitle("Run", bindings["query.run"])}
        onClick={handleRunClick}
      >
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path d="M3.5 2.2c0-.66.72-1.07 1.3-.73l8.5 4.8c.6.34.6 1.2 0 1.54l-8.5 4.8c-.58.34-1.3-.07-1.3-.73V2.2z" />
        </svg>
        Run
      </button>
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
