import { useEffect, useState } from "react";

import { compareSchemas, copyToClipboard, errorMessage, saveTextFile } from "../../api/backend";
import type { QueryTab } from "../../state/store";
import { useStore } from "../../state/store";
import type { ChangeKind, SchemaCompareResult, TableDiff } from "../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; result: SchemaCompareResult };

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

/**
 * Read-only schema-diff tab: compares `tab.compare.sourceSchema` (this tab's
 * own connection) against `tab.compare.targetSchema` on a different open
 * connection, showing a git-diff-style change list plus a best-effort
 * migration script. CubbyDB never runs the script itself — Copy and Export
 * are the only ways it leaves this pane.
 */
export function SchemaComparePane({ tab }: { tab: QueryTab }) {
  const compare = tab.compare;
  // This pane is only ever rendered for the active tab (see Workspace.tsx),
  // so the owning connection is always the active one — same reasoning
  // `TableStructurePane`'s `sessionId` relies on. The *target* session,
  // though, is a different connection entirely, so it always comes from
  // `compare.targetSessionId`, never from `activeConnectionId`.
  const sourceSessionId = useStore((s) => s.activeConnectionId);
  const sourceName = useStore((s) =>
    sourceSessionId ? s.connections[sourceSessionId]?.current.name : undefined,
  );
  const targetName = useStore((s) =>
    compare ? s.connections[compare.targetSessionId]?.current.name : undefined,
  );
  const swapSchemaCompare = useStore((s) => s.swapSchemaCompare);
  const showToast = useStore((s) => s.showToast);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!compare || !sourceSessionId) {
      setState({ kind: "error", message: "This tab has no comparison to show." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    compareSchemas(sourceSessionId, compare.sourceSchema, compare.targetSessionId, compare.targetSchema)
      .then((result) => {
        if (!cancelled) setState({ kind: "ok", result });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [compare, sourceSessionId, refreshNonce]);

  if (!compare) return null;

  const copySql = (sql: string) => {
    void copyToClipboard(sql).then(() => showToast("Copied migration SQL"));
  };
  const exportSql = (sql: string) => {
    void saveTextFile(`${compare.sourceSchema}_to_${compare.targetSchema}.sql`, sql, [
      { name: "SQL", extensions: ["sql"] },
    ])
      .then((path) => {
        if (path) showToast(`Saved ${path.split("/").pop()}`);
      })
      .catch((err) => showToast(errorMessage(err), "error"));
  };

  return (
    <div className="structure schema-compare">
      <div className="structure__scroll">
        <div className="schema-compare__header">
          <div className="schema-compare__crumb mono">
            <span>
              {sourceName ?? "this connection"}.{compare.sourceSchema}
            </span>
            <span className="schema-compare__arrow">⇄</span>
            <span>
              {targetName ?? compare.targetSessionId}.{compare.targetSchema}
            </span>
          </div>
          <div className="schema-compare__actions">
            <button type="button" className="btn btn--ghost" onClick={() => void swapSchemaCompare(tab.id)}>
              Swap direction
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setRefreshNonce((n) => n + 1)}>
              Refresh
            </button>
          </div>
        </div>

        <div className="schema-compare__disclaimer">
          CubbyDB never runs this SQL for you — copy or export it and run it with your own migration tool.
        </div>

        {state.kind === "loading" && <div className="structure__note">Comparing schemas…</div>}
        {state.kind === "error" && (
          <div className="structure__note structure__note--error">{state.message}</div>
        )}

        {state.kind === "ok" && (
          <>
            <section className="structure__section">
              <div className="structure__section-title caption">
                Changes ·{" "}
                {state.result.diff.tables.length === 0
                  ? "none"
                  : `${state.result.diff.tables.length} table${state.result.diff.tables.length === 1 ? "" : "s"}`}
              </div>
              {state.result.diff.tables.length === 0 ? (
                <div className="structure__note">These schemas are identical.</div>
              ) : (
                <div className="schema-compare__tables">
                  {state.result.diff.tables.map((table) => (
                    <TableDiffCard key={table.name} table={table} />
                  ))}
                </div>
              )}
            </section>

            <section className="structure__section">
              <div className="schema-compare__sql-head">
                <div className="structure__section-title caption">
                  Migration script · {state.result.migration.statementCount} statement
                  {state.result.migration.statementCount === 1 ? "" : "s"}
                </div>
                <div className="schema-compare__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => copySql(state.result.migration.sql)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => exportSql(state.result.migration.sql)}
                  >
                    Export…
                  </button>
                </div>
              </div>
              <pre className="schema-compare__sql mono">{state.result.migration.sql}</pre>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function kindClass(kind: ChangeKind): string {
  return `schema-compare__kind schema-compare__kind--${kind}`;
}

function TableDiffCard({ table }: { table: TableDiff }) {
  const wholeTable = table.kind === "added" || table.kind === "removed";
  return (
    <div className={`schema-compare__table schema-compare__table--${table.kind}`}>
      <div className="schema-compare__table-head">
        <span className={kindClass(table.kind)}>{KIND_LABEL[table.kind]}</span>
        <span className="mono schema-compare__table-name">{table.name}</span>
      </div>
      {!wholeTable && (
        <div className="schema-compare__items">
          {table.columns.map((c) => (
            <div key={`col:${c.name}`} className="schema-compare__item">
              <span className={kindClass(c.kind)}>{KIND_LABEL[c.kind]}</span>
              <span className="mono">column {c.name}</span>
              {c.kind === "changed" && c.before && c.after && (
                <span className="schema-compare__item-detail">
                  {c.before.dataType !== c.after.dataType && `${c.before.dataType} → ${c.after.dataType}`}
                  {c.before.nullable !== c.after.nullable &&
                    (c.after.nullable ? " · now nullable" : " · now NOT NULL")}
                  {c.before.defaultExpr !== c.after.defaultExpr &&
                    ` · default ${c.after.defaultExpr ?? "removed"}`}
                </span>
              )}
            </div>
          ))}
          {table.primaryKey && (
            <div className="schema-compare__item">
              <span className={kindClass(table.primaryKey.kind)}>{KIND_LABEL[table.primaryKey.kind]}</span>
              <span className="mono">primary key</span>
            </div>
          )}
          {table.uniqueConstraints.map((u) => (
            <div key={`uq:${u.name}`} className="schema-compare__item">
              <span className={kindClass(u.kind)}>{KIND_LABEL[u.kind]}</span>
              <span className="mono">unique {u.name}</span>
            </div>
          ))}
          {table.foreignKeys.map((fk) => (
            <div key={`fk:${fk.name}`} className="schema-compare__item">
              <span className={kindClass(fk.kind)}>{KIND_LABEL[fk.kind]}</span>
              <span className="mono">foreign key {fk.name}</span>
            </div>
          ))}
          {table.indexes.map((idx) => (
            <div key={`idx:${idx.name}`} className="schema-compare__item">
              <span className={kindClass(idx.kind)}>{KIND_LABEL[idx.kind]}</span>
              <span className="mono">index {idx.name}</span>
            </div>
          ))}
          {table.checkConstraints.map((chk) => (
            <div key={`chk:${chk.name}`} className="schema-compare__item">
              <span className={kindClass(chk.kind)}>{KIND_LABEL[chk.kind]}</span>
              <span className="mono">check {chk.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
