import { useMemo, useRef, useState } from "react";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import { useStore } from "../../state/store";
import type { ConnectionParams, SavedConnection } from "../../types";
import { AppFrame } from "../common/AppFrame";
import { Spinner } from "../common/Spinner";
import "./connection.css";

/** Editable form fields. Kept as strings; converted to params on submit. */
interface FormState {
  name: string;
  connectionString: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

const EMPTY_FORM: FormState = {
  name: "",
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

function paramsToForm(p: ConnectionParams, name = ""): FormState {
  return {
    name,
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
 *
 * `editSessionId`, when set, edits *that* live session in place instead of
 * opening a new one: the form is pre-filled from its actual name/params
 * (which works even if it was never saved), and the primary action becomes
 * "Reconnect" — applying the edit to that same session (same tabs/schema
 * slot) rather than adding another connection. Save/Update still manage its
 * saved record, if any, independently.
 */
export function ConnectionScreen(props: {
  embedded?: boolean;
  onConnected?: () => void;
  editSessionId?: string;
} = {}) {
  const { embedded, onConnected, editSessionId } = props;
  const savedConnections = useStore((s) => s.savedConnections);
  const loadSavedConnections = useStore((s) => s.loadSavedConnections);
  const connectTo = useStore((s) => s.connectTo);
  const reconnectSession = useStore((s) => s.reconnectSession);
  const lastConnection = useStore((s) => s.lastConnection);
  const reconnectError = useStore((s) => s.reconnectError);
  const renameLiveConnection = useStore((s) => s.renameLiveConnection);
  // Only read once, at mount, to seed the form below — this component
  // doesn't need to react to the slot changing after that.
  const [editSlot] = useState(() =>
    editSessionId ? useStore.getState().connections[editSessionId] ?? null : null,
  );

  // Prefill from: the session being edited, if any; else the last connection
  // (e.g. after a failed auto-reconnect) so getting back in is one click —
  // but not when embedded as an "add another connection" modal, where
  // prefilling with whatever's already connected would be confusing rather
  // than convenient.
  const [form, setForm] = useState<FormState>(() => {
    if (editSlot) return paramsToForm(editSlot.params, editSlot.current.name);
    if (!embedded && lastConnection) return paramsToForm(lastConnection.params);
    return EMPTY_FORM;
  });
  const [selectedId, setSelectedId] = useState<string | null>(
    editSlot?.current.connectionId ?? null,
  );
  // Tracks the latest selection synchronously, so an in-flight password
  // fetch from a previously-clicked card can tell it's been superseded and
  // skip applying its (now stale) result to the form.
  const selectedIdRef = useRef(selectedId);
  // The selected saved connection's *real* params (with password), used for
  // dirty-tracking below — `savedConnections` (the picker list) never
  // carries real passwords, so comparing against it directly would always
  // read as "dirty". `editSlot.params` is already real (a live session's
  // in-memory params), so it seeds this directly; otherwise `loadSaved`
  // fills it in once its fetch resolves.
  const [selectedRealParams, setSelectedRealParams] = useState<ConnectionParams | null>(
    editSlot?.params ?? null,
  );
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const params = useMemo(() => toParams(form), [form]);

  const hasInput =
    form.connectionString.trim() !== "" || form.host.trim() !== "";

  const selected = selectedId
    ? savedConnections.find((c) => c.id === selectedId) ?? null
    : null;
  // The name actually used on connect/save: whatever's typed in the Name
  // field, falling back to the auto-derived suggestion (mirrors the field's
  // own placeholder) when left blank.
  const derivedName = useMemo(() => deriveName(form), [form]);
  const effectiveName = form.name.trim() || derivedName;
  // Whether the form differs from the selected saved connection — either its
  // stored params or its name — drives whether we show one "Update" action
  // or an explicit "Update" + "Save as new" pair, instead of silently
  // switching between overwrite and create-new on every keystroke.
  const dirty = selected
    ? !paramsEqual(params, selectedRealParams ?? selected.params) || effectiveName !== selected.name
    : false;

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a previous test result (per spec). The selected
    // saved connection stays selected — see `dirty` above.
    setTest({ kind: "idle" });
    setConnectError(null);
  }

  /** Selects a saved connection and fills the form from it — `conn.params`
   *  (from the picker list) never carries the real password, so this fetches
   *  it fresh, just for this one entry, right when it's actually needed. */
  async function loadSaved(conn: SavedConnection) {
    setForm(paramsToForm(conn.params, conn.name));
    setSelectedId(conn.id);
    selectedIdRef.current = conn.id;
    // Cleared until the fetch below resolves, so `dirty` doesn't compare
    // against the *previous* selection's real params in the meantime.
    setSelectedRealParams(null);
    setTest({ kind: "idle" });
    setConnectError(null);
    try {
      const full = await api.getSavedConnection(conn.id);
      // A different card may have been clicked while this was in flight —
      // don't clobber whatever the user's since selected.
      if (full && selectedIdRef.current === conn.id) {
        setForm(paramsToForm(full.params, full.name));
        setSelectedRealParams(full.params);
      }
    } catch (err) {
      setConnectError(errorMessage(err));
    }
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
        name: effectiveName,
        id: selectedId ?? undefined,
      });
      onConnected?.();
    } catch (err) {
      setConnectError(errorMessage(err));
      setConnecting(false);
    }
  }

  /** Applies the edited params/name to the session being edited, in place —
   *  same tabs, same slot, just reconnected. If it came from a saved
   *  connection, that record is kept in sync too, so a future launch's
   *  auto-reconnect (or reopening it from the saved list) picks up the edit
   *  as well; an ad-hoc (never-saved) connection stays unsaved unless the
   *  user separately hits Save. */
  async function handleReconnect() {
    if (!editSessionId) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await reconnectSession(editSessionId, {
        params,
        name: effectiveName,
        id: selectedId ?? undefined,
      });
      if (selectedId) await handleSave("update");
      onConnected?.();
    } catch (err) {
      setConnectError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  /** `"new"` always creates a fresh saved connection; `"update"` overwrites
   *  the currently-selected one (only valid when one is selected). */
  async function handleSave(mode: "new" | "update" = "new") {
    const record: SavedConnection = {
      id: mode === "update" && selectedId ? selectedId : "",
      name: effectiveName,
      engine: "postgres",
      params,
      createdAt: 0,
    };
    try {
      const saved = await api.saveConnection(record);
      setSelectedId(saved.id);
      selectedIdRef.current = saved.id;
      setSelectedRealParams(saved.params);
      await loadSavedConnections();
      // If this saved connection is currently live (in this or another
      // connection's session), reflect the rename in the switcher right
      // away rather than only after reconnecting.
      if (mode === "update") renameLiveConnection(saved.id, saved.name);
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
    try {
      // `conn.params` (from the picker list) never carries the real
      // password — fetch it fresh so the duplicate isn't created passwordless.
      const full = await api.getSavedConnection(conn.id);
      const record: SavedConnection = {
        id: "",
        name: `${conn.name} copy`,
        engine: conn.engine,
        params: full?.params ?? conn.params,
        createdAt: 0,
      };
      const saved = await api.saveConnection(record);
      await loadSavedConnections();
      void loadSaved(saved);
    } catch (err) {
      setConnectError(errorMessage(err));
    }
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasInput && !connecting) {
      e.preventDefault();
      if (editSessionId) void handleReconnect();
      else void handleConnect();
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

            <Field
              label="Name"
              value={form.name}
              onChange={(v) => update("name", v)}
              placeholder={derivedName}
            />

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
                onClick={editSessionId ? handleReconnect : handleConnect}
                disabled={!hasInput || connecting}
                title={
                  editSessionId
                    ? "Apply these changes to the connection you're on now"
                    : undefined
                }
              >
                {connecting ? (
                  <>
                    <Spinner light /> {editSessionId ? "Reconnecting…" : "Connecting…"}
                  </>
                ) : editSessionId ? (
                  <>
                    Reconnect <span className="btn__kbd">⌘↵</span>
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
                  onClick={() => void loadSaved(conn)}
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
