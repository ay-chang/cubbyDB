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

export function ConnectionScreen() {
  const savedConnections = useStore((s) => s.savedConnections);
  const loadSavedConnections = useStore((s) => s.loadSavedConnections);
  const connectTo = useStore((s) => s.connectTo);
  const lastConnection = useStore((s) => s.lastConnection);
  const reconnectError = useStore((s) => s.reconnectError);

  // Prefill from the last connection (e.g. after a failed auto-reconnect) so
  // getting back in is one click.
  const [form, setForm] = useState<FormState>(() =>
    lastConnection ? paramsToForm(lastConnection.params) : EMPTY_FORM,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const params = useMemo(() => toParams(form), [form]);

  const hasInput =
    form.connectionString.trim() !== "" || form.host.trim() !== "";

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a previous test result (per spec).
    setTest({ kind: "idle" });
    setConnectError(null);
    setSelectedId(null);
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
        name: selectedId
          ? savedConnections.find((c) => c.id === selectedId)?.name ??
            deriveName(form)
          : deriveName(form),
        id: selectedId ?? undefined,
      });
    } catch (err) {
      setConnectError(errorMessage(err));
      setConnecting(false);
    }
  }

  async function handleSave() {
    const record: SavedConnection = {
      id: selectedId ?? "",
      name: deriveName(form),
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

  function onFormKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasInput && !connecting) {
      e.preventDefault();
      void handleConnect();
    }
  }

  return (
    <div className="conn-screen">
      <AppFrame title="New connection" maxWidth={1000}>
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
              <button
                className="btn btn--ghost"
                onClick={handleSave}
                disabled={!hasInput}
                title="Save this connection"
              >
                {selectedId ? "Update" : "Save"}
              </button>
            </div>

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
            {reconnectError && !connectError && test.kind === "idle" && (
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
                  <span
                    className="conn-card__delete"
                    onClick={(e) => handleDelete(conn.id, e)}
                    title="Delete"
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </AppFrame>
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
