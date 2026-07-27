import { PostgreSQL } from "@codemirror/lang-sql";
import { LanguageSupport } from "@codemirror/language";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";

import { errorMessage, getFunctionDefinition } from "../../api/backend";
import type { QueryTab } from "../../state/store";
import { useStore } from "../../state/store";
import { cubbyEditorTheme } from "./editorTheme";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; definition: string };

/**
 * Read-only "function" tab: one function/procedure's full body, via
 * Postgres's own `pg_get_functiondef()` — always accurate regardless of
 * language (SQL, PL/pgSQL, ...). Fetches its own data on mount, same as
 * `TableStructurePane` — cheap to re-fetch, nothing to persist.
 */
export function FunctionDefinitionPane({ tab }: { tab: QueryTab }) {
  const objectRef = tab.objectRef;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // This pane is only ever rendered for the active tab (see Workspace.tsx),
  // so the owning connection is always the active one.
  const sessionId = useStore((s) => s.activeConnectionId);
  const language = useMemo(() => new LanguageSupport(PostgreSQL.language), []);

  useEffect(() => {
    if (!objectRef?.oid || !sessionId) {
      setState({ kind: "error", message: "This tab has no function to show." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    getFunctionDefinition(sessionId, objectRef.oid)
      .then(({ definition }) => {
        if (!cancelled) setState({ kind: "ok", definition });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [objectRef?.oid, sessionId]);

  if (!objectRef) return null;

  return (
    <div className="structure">
      <div className="structure__head">
        <div className="structure__crumb mono">
          {objectRef.schema}.{objectRef.name}
        </div>
        {state.kind === "loading" && (
          <div className="structure__note">Loading definition…</div>
        )}
        {state.kind === "error" && (
          <div className="structure__note structure__note--error">{state.message}</div>
        )}
      </div>
      {state.kind === "ok" && (
        <div className="structure__code">
          <CodeMirror
            value={state.definition}
            extensions={[language, cubbyEditorTheme]}
            editable={false}
            theme="none"
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
            height="100%"
          />
        </div>
      )}
    </div>
  );
}
