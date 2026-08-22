import { useEffect, useMemo, useRef, useState } from "react";

import { errorMessage, getTableStructure } from "../../api/backend";
import type { QueryTab } from "../../state/store";
import { useActiveSchema, useStore } from "../../state/store";
import type { TableStructure } from "../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; structure: TableStructure };

/**
 * Read-only "structure" tab: a table's columns (with type, nullability,
 * default, primary/foreign keys), indexes, and check constraints. Fetches its
 * own data on mount rather than going through the tab's `result` — structure
 * data is cheap to re-fetch and doesn't need to survive tab switches, so
 * there's nothing to persist here.
 *
 * Deliberately does not attempt to show a full `CREATE TABLE` statement — see
 * the note on `TableStructure` in the Rust backend for why.
 */
export function TableStructurePane({ tab }: { tab: QueryTab }) {
  const source = tab.source;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // This pane is only ever rendered for the active tab (see Workspace.tsx),
  // so the owning connection is always the active one — and connection slots
  // are keyed by session id, so `activeConnectionId` *is* that session id.
  const sessionId = useStore((s) => s.activeConnectionId);

  useEffect(() => {
    if (!source || !sessionId) {
      setState({ kind: "error", message: "This tab has no table to show." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    getTableStructure(sessionId, source.schema, source.table)
      .then((structure) => {
        if (!cancelled) setState({ kind: "ok", structure });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [source, sessionId]);

  // Foreign keys aren't part of the backend's structure response — they're
  // already known from the schema tree, so pull them from there and merge by
  // column name rather than re-fetching them.
  const schema = useActiveSchema();
  const fkByColumn = useMemo(() => {
    if (!source) return new Map();
    const table = schema
      .find((s) => s.name === source.schema)
      ?.tables.find((t) => t.name === source.table);
    return new Map((table?.columns ?? []).map((c) => [c.name, c]));
  }, [schema, source]);

  // "Jump to column" from the command palette: scroll to and briefly flash
  // the requested column's row once the structure has finished loading.
  // Keyed by `nonce` so re-jumping to the same column re-triggers this even
  // though schema/table haven't changed.
  const pendingHighlight = useStore((s) => s.pendingColumnHighlight);
  const clearPendingColumnHighlight = useStore((s) => s.clearPendingColumnHighlight);
  const [highlightedColumn, setHighlightedColumn] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!source || !pendingHighlight || state.kind !== "ok") return;
    if (pendingHighlight.schema !== source.schema || pendingHighlight.table !== source.table) {
      return;
    }
    const el = scrollRef.current?.querySelector(
      `[data-column="${CSS.escape(pendingHighlight.column)}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedColumn(pendingHighlight.column);
    clearPendingColumnHighlight();
    const timer = window.setTimeout(() => setHighlightedColumn(null), 1800);
    return () => window.clearTimeout(timer);
  }, [source, pendingHighlight, state.kind, clearPendingColumnHighlight]);

  if (!source) return null;

  return (
    <div className="structure">
      <div className="structure__scroll" ref={scrollRef}>
        <div className="structure__crumb mono">
          {source.schema}.{source.table}
        </div>

        {state.kind === "loading" && (
          <div className="structure__note">Loading structure…</div>
        )}
        {state.kind === "error" && (
          <div className="structure__note structure__note--error">{state.message}</div>
        )}

        {state.kind === "ok" && (
          <>
            <section className="structure__section">
              <div className="structure__section-title caption">
                Columns · {state.structure.columns.length}
              </div>
              <div className="structure-table">
                <div className="structure-table__head">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Nullable</span>
                  <span>Default</span>
                  <span>Keys</span>
                </div>
                {state.structure.columns.map((col) => {
                  const fk = fkByColumn.get(col.name);
                  const isFk = (fk?.references.length ?? 0) > 0;
                  const isReferenced = (fk?.referencedBy.length ?? 0) > 0;
                  return (
                    <div
                      key={col.name}
                      data-column={col.name}
                      className={
                        "structure-table__row" +
                        (highlightedColumn === col.name ? " structure-table__row--highlight" : "")
                      }
                    >
                      <span className="mono">{col.name}</span>
                      <span className="mono structure-table__type">{col.dataType}</span>
                      <span>{col.nullable ? "yes" : "no"}</span>
                      <span className="mono structure-table__default">
                        {col.defaultExpr ?? (
                          <span className="structure-table__none">—</span>
                        )}
                      </span>
                      <span className="structure-table__badges">
                        {col.isPrimaryKey && (
                          <span className="structure-badge structure-badge--pk" title="Primary key">
                            PK
                          </span>
                        )}
                        {isFk && (
                          <span
                            className="structure-badge structure-badge--fk"
                            title={`References ${fk!.references[0].schema}.${fk!.references[0].table}.${fk!.references[0].column}`}
                          >
                            FK
                          </span>
                        )}
                        {isReferenced && (
                          <span
                            className="structure-badge"
                            title={`Referenced by ${fk!.referencedBy.length} column(s)`}
                          >
                            ←{fk!.referencedBy.length}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="structure__section">
              <div className="structure__section-title caption">
                Indexes · {state.structure.indexes.length}
              </div>
              {state.structure.indexes.length === 0 ? (
                <div className="structure__note">No indexes.</div>
              ) : (
                <div className="structure-list">
                  {state.structure.indexes.map((idx) => (
                    <div key={idx.name} className="structure-list__item">
                      <span className="structure-list__name mono">{idx.name}</span>
                      <code className="structure-list__def">{idx.definition}</code>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="structure__section">
              <div className="structure__section-title caption">
                Check constraints · {state.structure.checkConstraints.length}
              </div>
              {state.structure.checkConstraints.length === 0 ? (
                <div className="structure__note">No check constraints.</div>
              ) : (
                <div className="structure-list">
                  {state.structure.checkConstraints.map((c) => (
                    <div key={c.name} className="structure-list__item">
                      <span className="structure-list__name mono">{c.name}</span>
                      <code className="structure-list__def">{c.definition}</code>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="structure__section">
              <div className="structure__section-title caption">
                Triggers · {state.structure.triggers.length}
              </div>
              {state.structure.triggers.length === 0 ? (
                <div className="structure__note">No triggers.</div>
              ) : (
                <div className="structure-list">
                  {state.structure.triggers.map((t) => (
                    <div key={t.name} className="structure-list__item">
                      <span className="structure-list__name mono">{t.name}</span>
                      <code className="structure-list__def">{t.definition}</code>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="structure__section">
              <div className="structure__section-title caption">
                Row-level security
              </div>
              {!state.structure.rlsEnabled ? (
                <div className="structure__note">Row-level security is not enabled on this table.</div>
              ) : state.structure.rlsPolicies.length === 0 ? (
                <div className="structure__note structure__note--warning">
                  Row-level security is enabled with no policies — every role except the table
                  owner is denied by default.
                </div>
              ) : (
                <div className="structure-list">
                  {state.structure.rlsPolicies.map((p) => (
                    <div key={p.name} className="structure-list__item">
                      <span className="structure-list__name mono">
                        {p.name}
                        <span className="structure-table__default">
                          {" "}
                          · {p.permissive} · {p.command} · {p.roles.join(", ")}
                        </span>
                      </span>
                      {(p.usingExpr || p.checkExpr) && (
                        <code className="structure-list__def">
                          {p.usingExpr && `USING (${p.usingExpr})`}
                          {p.usingExpr && p.checkExpr && "\n"}
                          {p.checkExpr && `WITH CHECK (${p.checkExpr})`}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
