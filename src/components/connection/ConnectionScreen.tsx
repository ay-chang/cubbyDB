import { useMemo, useState } from "react";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import {
  ACCENT_COLOR_LABELS,
  ACCENT_COLOR_OPTIONS,
  ACCENT_COLOR_SWATCH,
  DEFAULT_CONNECTION_COLOR_STYLE,
  isAccentColor,
  isConnectionColorStyle,
  useStore,
} from "../../state/store";
import type { AccentColor, ConnectionColorStyle } from "../../state/store";
import type { ConnectionParams, SavedConnection } from "../../types";
import { AppFrame } from "../common/AppFrame";
import { Spinner } from "../common/Spinner";
import { Toggle } from "../common/Toggle";
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
  const setConnectionColor = useStore((s) => s.setConnectionColor);
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
  const [color, setColor] = useState<AccentColor | null>(editSlot?.color ?? null);
  const [colorStyle, setColorStyle] = useState<ConnectionColorStyle>(
    editSlot?.colorStyle ?? DEFAULT_CONNECTION_COLOR_STYLE,
  );
  const [formTab, setFormTab] = useState<"connection" | "color">("connection");
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
    ? !paramsEqual(params, selected.params) ||
      effectiveName !== selected.name ||
      color !== (isAccentColor(selected.color) ? selected.color : null) ||
      colorStyle !== (isConnectionColorStyle(selected.colorStyle) ? selected.colorStyle : DEFAULT_CONNECTION_COLOR_STYLE)
    : false;

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a previous test result (per spec). The selected
    // saved connection stays selected — see `dirty` above.
    setTest({ kind: "idle" });
    setConnectError(null);
  }

  function loadSaved(conn: SavedConnection) {
    setForm(paramsToForm(conn.params, conn.name));
    setSelectedId(conn.id);
    setColor(isAccentColor(conn.color) ? conn.color : null);
    setColorStyle(
      isConnectionColorStyle(conn.colorStyle) ? conn.colorStyle : DEFAULT_CONNECTION_COLOR_STYLE,
    );
    setTest({ kind: "idle" });
    setConnectError(null);
  }

  /** Loads a saved connection into the form *and* connects immediately —
   *  the one-click path from the saved list, vs. `loadSaved` (load only,
   *  reviewed before hitting Connect). */
  async function connectSaved(conn: SavedConnection, e: React.MouseEvent) {
    e.stopPropagation();
    setConnecting(true);
    setConnectError(null);
    try {
      await connectTo({ params: conn.params, name: conn.name, id: conn.id });
      onConnected?.();
    } catch (err) {
      setConnectError(errorMessage(err));
    } finally {
      setConnecting(false);
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
      const newSessionId = useStore.getState().activeConnectionId;
      if (newSessionId) await setConnectionColor(newSessionId, color, colorStyle);
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
      await setConnectionColor(editSessionId, color, colorStyle);
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
      color,
      colorStyle,
    };
    try {
      const saved = await api.saveConnection(record);
      setSelectedId(saved.id);
      await loadSavedConnections();
      // If this saved connection is currently live (in this or another
      // connection's session), reflect the rename in the switcher right
      // away rather than only after reconnecting.
      if (mode === "update") renameLiveConnection(saved.id, saved.name);
      // Likewise for color/style — Update alone (unlike Connect/Reconnect)
      // doesn't otherwise touch the live slot, so a color-only edit to an
      // already-saved, already-live connection wouldn't show up until a
      // separate reconnect.
      const liveEntry = Object.entries(useStore.getState().connections).find(
        ([, slot]) => slot.current.connectionId === saved.id,
      );
      if (mode === "update" && liveEntry) {
        await setConnectionColor(liveEntry[0], color, colorStyle);
      }

      // First save of a live but never-saved (ad-hoc) session — e.g. the AI
      // panel's or the right-click "Edit" form's "save this connection" path.
      // `handleSave` alone only wrote the *saved-connections list*; without
      // this, the live session's own `connectionId` stayed null, so it kept
      // reading as unsaved (no chat history, "Save" offered again) until a
      // separate manual Reconnect. Link the two here so one click finishes
      // the job — reconnecting is a no-op on the actual DB connection since
      // nothing about the params changed, just the identity now attached.
      if (editSessionId && mode === "new" && !editSlot?.current.connectionId) {
        await reconnectSession(editSessionId, { params, name: saved.name, id: saved.id });
        await setConnectionColor(editSessionId, color, colorStyle);
        onConnected?.();
      }
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
      color: conn.color,
      colorStyle: conn.colorStyle,
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

            <div className="settings-subtabs conn-form-tabs">
              <button
                type="button"
                className={"settings-subtab" + (formTab === "connection" ? " settings-subtab--active" : "")}
                onClick={() => setFormTab("connection")}
              >
                Connection
              </button>
              <button
                type="button"
                className={"settings-subtab" + (formTab === "color" ? " settings-subtab--active" : "")}
                onClick={() => setFormTab("color")}
              >
                Color
              </button>
            </div>

            {/* Both panels stay mounted, overlaid in the same grid cell (one
                just `visibility: hidden`) so the taller one — always
                Connection — sets the height regardless of which is showing.
                Otherwise switching to the shorter Color tab visibly shrank
                the whole dialog. */}
            <div className="conn-form-tabpanel">
              <div
                className={"conn-form-tabpage" + (formTab === "connection" ? "" : " conn-form-tabpage--hidden")}
              >
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
              </div>

              <div
                className={"conn-form-tabpage" + (formTab === "color" ? "" : " conn-form-tabpage--hidden")}
              >
                <div className="conn-field">
                  <span className="caption">Color</span>
                  <div className="color-menu__grid">
                    <button
                      type="button"
                      className={
                        "color-menu__swatch color-menu__swatch--none" +
                        (!color ? " color-menu__swatch--active" : "")
                      }
                      onClick={() => setColor(null)}
                      title="No color"
                      aria-label="No color"
                    >
                      {!color && "✓"}
                    </button>
                    {ACCENT_COLOR_OPTIONS.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={
                          "color-menu__swatch" + (color === c ? " color-menu__swatch--active" : "")
                        }
                        style={{ background: ACCENT_COLOR_SWATCH[c] }}
                        onClick={() => setColor(c)}
                        title={ACCENT_COLOR_LABELS[c]}
                        aria-label={ACCENT_COLOR_LABELS[c]}
                      >
                        {color === c && "✓"}
                      </button>
                    ))}
                  </div>
                  {color && (
                    <div className="conn-color-style">
                      <span>Highlight whole table</span>
                      <Toggle
                        on={colorStyle === "fill"}
                        onToggle={() => setColorStyle(colorStyle === "fill" ? "border" : "fill")}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="conn-actions">
              {formTab === "connection" && (
                <>
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
                </>
              )}
              {selected ? (
                <>
                  <button
                    className="btn btn--outline"
                    onClick={() => handleSave("update")}
                    disabled={!hasInput || !dirty}
                    title={`Overwrite "${selected.name}" with these values`}
                  >
                    Update
                  </button>
                  {dirty && (
                    <button
                      className="btn btn--outline"
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
                  className="btn btn--outline"
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
                      style={
                        isAccentColor(conn.color)
                          ? { background: ACCENT_COLOR_SWATCH[conn.color] }
                          : undefined
                      }
                    />
                    {conn.name}
                  </span>
                  <span className="conn-card__sub mono">{savedSubtitle(conn)}</span>
                  <span className="conn-card__actions">
                    <span
                      className="conn-card__connect"
                      onClick={(e) => void connectSaved(conn, e)}
                      title="Connect"
                    >
                      ▶
                    </span>
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
