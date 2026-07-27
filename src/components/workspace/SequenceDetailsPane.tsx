import { useEffect, useMemo, useState } from "react";

import { errorMessage, getSequenceDetails } from "../../api/backend";
import type { QueryTab } from "../../state/store";
import { useActiveSchema, useStore } from "../../state/store";
import type { SequenceDetails } from "../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; details: SequenceDetails };

/**
 * Read-only "sequence" tab: one sequence's current value and configuration,
 * straight from Postgres's own `pg_sequences` view. Fetches its own data on
 * mount, same as `TableStructurePane` — cheap to re-fetch, nothing to
 * persist.
 */
export function SequenceDetailsPane({ tab }: { tab: QueryTab }) {
  const objectRef = tab.objectRef;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const sessionId = useStore((s) => s.activeConnectionId);

  useEffect(() => {
    if (!objectRef || !sessionId) {
      setState({ kind: "error", message: "This tab has no sequence to show." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    getSequenceDetails(sessionId, objectRef.schema, objectRef.name)
      .then((details) => {
        if (!cancelled) setState({ kind: "ok", details });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [objectRef, sessionId]);

  // The owning table/column is already known from the schema tree — pull it
  // from there rather than re-fetching, same trick `TableStructurePane` uses
  // for foreign keys.
  const schema = useActiveSchema();
  const ownedBy = useMemo(() => {
    if (!objectRef) return null;
    return (
      schema
        .find((s) => s.name === objectRef.schema)
        ?.sequences.find((seq) => seq.name === objectRef.name)?.ownedBy ?? null
    );
  }, [schema, objectRef]);

  if (!objectRef) return null;

  return (
    <div className="structure">
      <div className="structure__scroll">
        <div className="structure__crumb mono">
          {objectRef.schema}.{objectRef.name}
        </div>

        {state.kind === "loading" && (
          <div className="structure__note">Loading sequence…</div>
        )}
        {state.kind === "error" && (
          <div className="structure__note structure__note--error">{state.message}</div>
        )}

        {state.kind === "ok" && (
          <section className="structure__section">
            <div className="structure-kv">
              <Row label="Data type" value={state.details.dataType} />
              <Row
                label="Current value"
                value={state.details.lastValue != null ? String(state.details.lastValue) : "— (never used)"}
              />
              <Row label="Start value" value={String(state.details.startValue)} />
              <Row label="Min value" value={String(state.details.minValue)} />
              <Row label="Max value" value={String(state.details.maxValue)} />
              <Row label="Increment by" value={String(state.details.incrementBy)} />
              <Row label="Cache size" value={String(state.details.cacheSize)} />
              <Row label="Cycle" value={state.details.cycle ? "yes" : "no"} />
              <Row
                label="Owned by"
                value={ownedBy ? `${ownedBy.table}.${ownedBy.column}` : "— (standalone)"}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="structure-kv__row">
      <span className="structure-kv__label">{label}</span>
      <span className="structure-kv__value mono">{value}</span>
    </div>
  );
}
