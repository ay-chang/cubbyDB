import { useMemo, useState } from "react";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import { useStore } from "../../state/store";
import type { ConnectionParams, SavedConnection } from "../../types";
import { AppFrame } from "../common/AppFrame";
import { Spinner } from "../common/Spinner";
import "./connection.css";

/** Editable form fields. Kept as strings; converted to params on submit. */
interface FormState {
  connectionString: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

const EMPTY_FORM: FormState = {
  connectionString: "",
  host: "",
  port: "",
  database: "",
  user: "",
  password: "",
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string };

function toParams(form: FormState): ConnectionParams {
  const trimmed = form.connectionString.trim();
  return {
    connectionString: trimmed ? trimmed : null,
    host: form.host.trim() || null,
    port: form.port.trim() ? Number(form.port.trim()) : null,
    database: form.database.trim() || null,
    user: form.user.trim() || null,
    password: form.password ? form.password : null,
  };
}

function paramsToForm(p: ConnectionParams): FormState {
  return {
    connectionString: p.connectionString ?? "",
    host: p.host ?? "",
    port: p.port != null ? String(p.port) : "",
    database: p.database ?? "",
    user: p.user ?? "",
    password: p.password ?? "",
  };
}

/** Derive a display name for saving, mirroring the design's saved cards. */
function deriveName(form: FormState): string {
  if (form.database.trim()) return form.database.trim();
  if (form.host.trim()) return form.host.trim();
  const cs = form.connectionString.trim();
  if (cs) {
    const match = cs.match(/\/([^/?]+)(\?|$)/);
    if (match) return match[1];
  }
  return "connection";
}

function savedSubtitle(conn: SavedConnection): string {
  const { params } = conn;
  if (params.host) return `${params.host}:${params.port ?? 5432}`;
  if (params.connectionString) {
    return params.connectionString.replace(/:[^:@/]*@/, ":****@");
  }
  return "connection string";
}

/** Params equality for dirty-tracking — undefined and null both mean "unset". */
function paramsEqual(a: ConnectionParams, b: ConnectionParams): boolean {
  const norm = (p: ConnectionParams) => ({
    connectionString: p.connectionString ?? null,
    host: p.host ?? null,
    port: p.port ?? null,
    database: p.database ?? null,
    user: p.user ?? null,
    password: p.password ?? null,
  });
  const na = norm(a);
  const nb = norm(b);
  return (
    na.connectionString === nb.connectionString &&
    na.host === nb.host &&
    na.port === nb.port &&
    na.database === nb.database &&
    na.user === nb.user &&
    na.password === nb.password
  );
}

/**
 * `embedded`, when true, renders just the form + saved-list grid without the
 * full-page window chrome (`AppFrame`) — used to add a second (or third...)
 * connection from a modal while already connected, rather than replacing the
 * whole screen. The plain full-page version is still used for the very first
 * connection (`connections` empty, per `Workspace`/`App`'s routing).
 */
export function ConnectionScreen(props: {
  embedded?: boolean;
  onConnected?: () => void;
} = {}) {
  const { embedded, onConnected } = props;
  const savedConnections = useStore((s) => s.savedConnections);
  const loadSavedConnections = useStore((s) => s.loadSavedConnections);
  const connectTo = useStore((s) => s.connectTo);
  const lastConnection = useStore((s) => s.lastConnection);
  const reconnectError = useStore((s) => s.reconnectError);

  // Prefill from the last connection (e.g. after a failed auto-reconnect) so
  // getting back in is one click — but not when embedded as an "add another
  // connection" modal, where prefilling with whatever's already connected
  // would be confusing rather than convenient.
  const [form, setForm] = useState<FormState>(() =>
    !embedded && lastConnection ? paramsToForm(lastConnection.params) : EMPTY_FORM,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const params = useMemo(() => toParams(form), [form]);

  const hasInput =
    form.connectionString.trim() !== "" || form.host.trim() !== "";

  const selected = selectedId
    ? savedConnections.find((c) => c.id === selectedId) ?? null
    : null;
  // Whether the form differs from the selected saved connection's stored
  // params — drives whether we show one "Update" action or an explicit
  // "Update" + "Save as new" pair, instead of silently switching between
  // overwrite and create-new on every keystroke.
  const dirty = selected ? !paramsEqual(params, selected.params) : false;

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a previous test result (per spec). The selected
    // saved connection stays selected — see `dirty` above.
    setTest({ kind: "idle" });
    setConnectError(null);
  }

  function loadSaved(conn: SavedConnection) {
    setForm(paramsToForm(conn.params));
    setSelectedId(conn.id);
    setTest({ kind: "idle" });
    setConnectError(null);
  }

  async function handleTest() {
    setTest({ kind: "testing" });
    try {
      const info = await api.testConnection(params);
      setTest({
        kind: "ok",
        label: `Connected · ${info.elapsedMs} ms · Postgres ${info.serverVersion}`,
      });
    } catch (err) {
      setTest({ kind: "error", message: errorMessage(err) });
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await connectTo({
        params,
        name: selected?.name ?? deriveName(form),
        id: selectedId ?? undefined,
      });
      onConnected?.();
    } catch (err) {
      setConnectError(errorMessage(err));
      setConnecting(false);
    }
  }

  /** `"new"` always creates a fresh saved connection; `"update"` overwrites
   *  the currently-selected one (only valid when one is selected). */
  async function handleSave(mode: "new" | "update" = "new") {
    const record: SavedConnection = {
      id: mode === "update" && selectedId ? selectedId : "",
      name: mode === "update" && selected ? selected.name : deriveName(form),
      engine: "postgres",
      params,
      createdAt: 0,
    };
    try {
      const saved = await api.saveConnection(record);
      setSelectedId(saved.id);
      await loadSavedConnections();
    } catch (err) {
      setConnectError(errorMessage(err));
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.deleteConnection(id);
      if (selectedId === id) setSelectedId(null);
      await loadSavedConnections();
    } catch (err) {
      setConnectError(errorMessage(err));
    }
  }

  async function handleDuplicate(conn: SavedConnection, e: React.MouseEvent) {
    e.stopPropagation();
    const record: SavedConnection = {
      id: "",
      name: `${conn.name} copy`,
      engine: conn.engine,
      params: conn.params,
      createdAt: 0,
    };
    try {
      const saved = await api.saveConnection(record);
      await loadSavedConnections();
      loadSaved(saved);
    } catch (err) {
      setConnectError(errorMessage(err));
    }
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasInput && !connecting) {
      e.preventDefault();
      void handleConnect();
    }
  }

  const body = (
        <div className="conn-body" onKeyDown={onFormKeyDown}>
          {/* --- Form --- */}
          <div className="conn-form">
            <div className="conn-form__head">
              <h3>Connect to Postgres</h3>
              <p>Paste a connection string, or fill in the fields below.</p>
            </div>

            <label className="conn-field">
              <span className="caption">Connection string</span>
              <input
                className="conn-input conn-input--mono"
                placeholder="postgresql://user:password@host:5432/database"
                value={form.connectionString}
                onChange={(e) => update("connectionString", e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>

            <div className="conn-or">
              <span />
              <span className="conn-or__label">or</span>
              <span />
            </div>

            <div className="conn-row conn-row--host">
              <Field
                label="Host"
                value={form.host}
                onChange={(v) => update("host", v)}
                placeholder="localhost"
              />
              <Field
                label="Port"
                value={form.port}
                onChange={(v) => update("port", v)}
                placeholder="5432"
              />
            </div>

            <div className="conn-row conn-row--pair">
              <Field
                label="Database"
                value={form.database}
                onChange={(v) => update("database", v)}
                placeholder="postgres"
              />
              <Field
                label="User"
                value={form.user}
                onChange={(v) => update("user", v)}
                placeholder="postgres"
              />
            </div>

            <Field
              label="Password"
              type="password"
              value={form.password}
              onChange={(v) => update("password", v)}
              placeholder="••••••••••"
            />

            <div className="conn-actions">
              <button
                className="btn btn--primary"
                onClick={handleConnect}
                disabled={!hasInput || connecting}
              >
                {connecting ? (
                  <>
                    <Spinner light /> Connecting…
                  </>
                ) : (
                  <>
                    Connect <span className="btn__kbd">⌘↵</span>
                  </>
                )}
              </button>
              <button
                className="btn btn--outline"
                onClick={handleTest}
                disabled={!hasInput || test.kind === "testing"}
              >
                Test connection
              </button>
              {selected ? (
                <>
                  <button
                    className="btn btn--ghost"
                    onClick={() => handleSave("update")}
                    disabled={!hasInput || !dirty}
                    title={`Overwrite "${selected.name}" with these values`}
                  >
                    Update
                  </button>
                  {dirty && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => handleSave("new")}
                      disabled={!hasInput}
                      title="Save these values as a new connection, leaving the original unchanged"
                    >
                      Save as new
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="btn btn--ghost"
                  onClick={() => handleSave("new")}
                  disabled={!hasInput}
                  title="Save this connection"
                >
                  Save
                </button>
              )}
            </div>

            {selected && (
              <p className="conn-editing-note caption">
                Editing <strong>{selected.name}</strong>
                {dirty && " · unsaved changes"}
              </p>
            )}

            {/* --- Test / connect states (inline, never modal) --- */}
            {test.kind === "testing" && (
              <div className="conn-state conn-state--testing">
                <Spinner /> Testing…
              </div>
            )}
            {test.kind === "ok" && (
              <div className="conn-state conn-state--ok">
                <span className="conn-state__glyph">✓</span>
                {test.label}
              </div>
            )}
            {test.kind === "error" && (
              <div className="conn-state conn-state--error">
                <div className="conn-state__title">
                  <span>✕</span>Connection failed
                </div>
                <span className="conn-state__detail mono">{test.message}</span>
              </div>
            )}
            {connectError && test.kind !== "error" && (
              <div className="conn-state conn-state--error">
                <div className="conn-state__title">
                  <span>✕</span>Could not connect
                </div>
                <span className="conn-state__detail mono">{connectError}</span>
              </div>
            )}
            {!embedded && reconnectError && !connectError && test.kind === "idle" && (
              <div className="conn-state conn-state--error">
                <div className="conn-state__title">
                  <span>✕</span>Couldn't reconnect automatically
                </div>
                <span className="conn-state__detail mono">{reconnectError}</span>
              </div>
            )}
          </div>

          {/* --- Saved list --- */}
          <div className="conn-saved">
            <div className="conn-saved__head">
              <span className="caption">Saved</span>
            </div>
            <div className="conn-saved__list">
              {savedConnections.length === 0 && (
                <p className="conn-saved__empty">
                  No saved connections yet. Fill the form and press Save.
                </p>
              )}
              {savedConnections.map((conn) => (
                <button
                  key={conn.id}
                  className={
                    "conn-card" + (selectedId === conn.id ? " conn-card--active" : "")
                  }
                  onClick={() => loadSaved(conn)}
                >
                  <span className="conn-card__name">
                    <span
                      className={
                        "conn-card__dot" +
                        (selectedId === conn.id ? " conn-card__dot--live" : "")
                      }
                    />
                    {conn.name}
                  </span>
                  <span className="conn-card__sub mono">{savedSubtitle(conn)}</span>
                  <span className="conn-card__actions">
                    <span
                      className="conn-card__duplicate"
                      onClick={(e) => void handleDuplicate(conn, e)}
                      title="Duplicate"
                    >
                      ⧉
                    </span>
                    <span
                      className="conn-card__delete"
                      onClick={(e) => handleDelete(conn.id, e)}
                      title="Delete"
                    >
                      ×
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
  );

  if (embedded) return body;

  return (
    <div className="conn-screen">
      <AppFrame title="New connection" maxWidth={1000}>{body}</AppFrame>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="conn-field">
      <span className="caption">{props.label}</span>
      <input
        className="conn-input"
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </label>
  );
}
