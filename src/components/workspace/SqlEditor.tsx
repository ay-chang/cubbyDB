import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";

import { cubbyEditorTheme } from "./editorTheme";

/**
 * The SQL editor for one tab. CodeMirror 6 with Postgres dialect highlighting.
 * Cmd/Ctrl+Enter runs the query. Autocomplete is intentionally disabled (out of
 * scope for v1).
 */
export function SqlEditor(props: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  // Keep the run handler in a ref so the keymap extension is stable across
  // renders but always calls the latest handler.
  const runRef = useRef(props.onRun);
  runRef.current = props.onRun;

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              runRef.current();
              return true;
            },
          },
        ]),
      ),
      cubbyEditorTheme,
    ],
    [],
  );

  return (
    <div className="editor">
      <CodeMirror
        value={props.value}
        onChange={props.onChange}
        extensions={extensions}
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
