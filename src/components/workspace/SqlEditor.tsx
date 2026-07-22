import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";

import { statementAt } from "../../lib/sqlStatements";
import { useStore } from "../../state/store";
import { cubbyEditorTheme } from "./editorTheme";

/**
 * The SQL editor for one tab. CodeMirror 6 with Postgres dialect highlighting.
 * Cmd/Ctrl+Enter runs the selection (if any) or the statement under the
 * cursor; Cmd/Ctrl+Shift+Enter always runs the whole buffer. Autocomplete is
 * intentionally disabled (out of scope for v1).
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

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: (view) => {
              const sel = view.state.selection.main;
              const text = !sel.empty
                ? view.state.sliceDoc(sel.from, sel.to)
                : sliceStatementAtCursor(view.state.doc.toString(), sel.from);
              runRef.current(text);
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
        ]),
      ),
      cubbyEditorTheme,
      ...(lineWrap ? [EditorView.lineWrapping] : []),
    ],
    [lineWrap],
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
          autocompletion: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          bracketMatching: true,
          indentOnInput: false,
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
