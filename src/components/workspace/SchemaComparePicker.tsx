import { useMemo, useState } from "react";

import { useStore } from "../../state/store";

/**
 * Small overlay for starting a Schema Compare: pick another already-open
 * connection and one of its schemas, then open (or focus) the compare tab.
 * Deliberately only lists connections that are already open — comparing
 * against a saved-but-unopened connection would need its own "connect just
 * to diff" flow, which this feature doesn't have.
 */
export function SchemaComparePicker({
  sourceSessionId,
  sourceSchema,
  onClose,
}: {
  sourceSessionId: string;
  sourceSchema: string;
  onClose: () => void;
}) {
  const connections = useStore((s) => s.connections);
  const openSchemaCompare = useStore((s) => s.openSchemaCompare);

  const others = useMemo(
    () => Object.values(connections).filter((slot) => slot.sessionId !== sourceSessionId),
    [connections, sourceSessionId],
  );

  const [targetSessionId, setTargetSessionId] = useState(others[0]?.sessionId ?? "");
  const targetSchemas = connections[targetSessionId]?.schema.map((s) => s.name) ?? [];
  const [targetSchema, setTargetSchema] = useState(targetSchemas[0] ?? "");

  const handleTargetSessionChange = (id: string) => {
    setTargetSessionId(id);
    setTargetSchema(connections[id]?.schema[0]?.name ?? "");
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="add-connection-card"
        role="dialog"
        aria-modal="true"
        aria-label="Compare schema"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__head">
          <span className="settings-panel__title">Compare {sourceSchema}</span>
          <button className="settings-panel__close" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>

        {others.length === 0 ? (
          <div className="conn-form">
            <p className="structure__note">Open another connection first to compare against it.</p>
          </div>
        ) : (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!targetSessionId || !targetSchema) return;
              void openSchemaCompare(sourceSchema, targetSessionId, targetSchema);
              onClose();
            }}
          >
            <label className="conn-field">
              <span className="caption">Compare against connection</span>
              <select
                className="conn-input"
                value={targetSessionId}
                onChange={(e) => handleTargetSessionChange(e.target.value)}
                autoFocus
              >
                {others.map((slot) => (
                  <option key={slot.sessionId} value={slot.sessionId}>
                    {slot.current.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="conn-field">
              <span className="caption">Schema</span>
              <select
                className="conn-input"
                value={targetSchema}
                onChange={(e) => setTargetSchema(e.target.value)}
                disabled={targetSchemas.length === 0}
              >
                {targetSchemas.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <div className="conn-actions">
              <button type="submit" className="btn btn--primary" disabled={!targetSessionId || !targetSchema}>
                Compare
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
