import { useEffect, useMemo, useState } from "react";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import { matchesKeybinding, useKeybindingStore } from "../../lib/keybindings";
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
import type {
  ConnectionParams,
  SavedConnection,
  SshAuthMethod,
  SshHostKeyProbe,
  SshTunnelParams,
} from "../../types";
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
  readOnly: boolean;
  sshEnabled: boolean;
  sshBastionHost: string;
  sshBastionPort: string;
  sshBastionUser: string;
  sshAuthMethod: SshAuthMethod["method"];
  sshPassword: string;
  /** The key's own contents, read off disk once by the "Browse…" button
   *  (see `pickAndReadTextFile`) — `sshKeyFilename` alongside it is purely
   *  cosmetic feedback, never sent to the backend. */
  sshKeyContents: string;
  sshKeyFilename: string;
  sshKeyPassphrase: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  connectionString: "",
  host: "",
  port: "",
  database: "",
  user: "",
  password: "",
  readOnly: false,
  sshEnabled: false,
  sshBastionHost: "",
  sshBastionPort: "22",
  sshBastionUser: "",
  sshAuthMethod: "password",
  sshPassword: "",
  sshKeyContents: "",
  sshKeyFilename: "",
  sshKeyPassphrase: "",
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string };

function authFromForm(form: FormState): SshAuthMethod {
  switch (form.sshAuthMethod) {
    case "privateKey":
      return {
        method: "privateKey",
        keyContents: form.sshKeyContents || null,
        passphrase: form.sshKeyPassphrase || null,
      };
    case "agent":
      return { method: "agent" };
    case "password":
    default:
      return { method: "password", password: form.sshPassword || null };
  }
}

function sshFromForm(form: FormState): SshTunnelParams | null {
  if (!form.sshEnabled) return null;
  return {
    enabled: true,
    bastionHost: form.sshBastionHost.trim() || null,
    bastionPort: form.sshBastionPort.trim() ? Number(form.sshBastionPort.trim()) : 22,
    bastionUser: form.sshBastionUser.trim() || null,
    auth: authFromForm(form),
  };
}

function toParams(form: FormState): ConnectionParams {
  const trimmed = form.connectionString.trim();
  return {
    connectionString: trimmed ? trimmed : null,
    host: form.host.trim() || null,
    port: form.port.trim() ? Number(form.port.trim()) : null,
    database: form.database.trim() || null,
    user: form.user.trim() || null,
    password: form.password ? form.password : null,
    readOnly: form.readOnly,
    ssh: sshFromForm(form),
  };
}

function paramsToForm(p: ConnectionParams, name = ""): FormState {
  const ssh = p.ssh;
  const auth = ssh?.auth;
  return {
    name,
    connectionString: p.connectionString ?? "",
    host: p.host ?? "",
    port: p.port != null ? String(p.port) : "",
    database: p.database ?? "",
    user: p.user ?? "",
    password: p.password ?? "",
    readOnly: p.readOnly ?? false,
    sshEnabled: ssh?.enabled ?? false,
    sshBastionHost: ssh?.bastionHost ?? "",
    sshBastionPort: ssh?.bastionPort != null ? String(ssh.bastionPort) : "22",
    sshBastionUser: ssh?.bastionUser ?? "",
    sshAuthMethod: auth?.method ?? "password",
    sshPassword: (auth?.method === "password" && auth.password) || "",
    sshKeyContents: (auth?.method === "privateKey" && auth.keyContents) || "",
    sshKeyFilename: "",
    sshKeyPassphrase: (auth?.method === "privateKey" && auth.passphrase) || "",
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
  const base = params.host
    ? `${params.host}:${params.port ?? 5432}`
    : params.connectionString
      ? params.connectionString.replace(/:[^:@/]*@/, ":****@")
      : "connection string";
  const tags = [
    params.readOnly ? "read-only" : null,
    params.ssh?.enabled ? "via SSH" : null,
  ].filter(Boolean);
  return tags.length ? `${base} · ${tags.join(" · ")}` : base;
}

/** Normalizes `ssh` to exactly `null` when disabled — `sshFromForm` already
 *  collapses a toggled-off tunnel this way, so a form with stale bastion
 *  fields left over from a previous edit doesn't read as "dirty" against a
 *  saved connection that's simply off. */
function normalizedSsh(p: ConnectionParams): SshTunnelParams | null {
  return p.ssh?.enabled ? p.ssh : null;
}

/** Params equality for dirty-tracking — undefined and null both mean "unset".
 *  `ssh` is compared via `JSON.stringify` rather than field-by-field like
 *  everything else here: it's a nested tagged union (auth method plus
 *  whichever of password/key/passphrase that method uses), and a
 *  hand-written comparison risks silently missing a field the next time the
 *  shape changes — a stale "not dirty" from a forgotten field is a worse
 *  failure mode here than the shortcut. */
function paramsEqual(a: ConnectionParams, b: ConnectionParams): boolean {
  const norm = (p: ConnectionParams) => ({
    connectionString: p.connectionString ?? null,
    host: p.host ?? null,
    port: p.port ?? null,
    database: p.database ?? null,
    user: p.user ?? null,
    password: p.password ?? null,
    readOnly: p.readOnly ?? false,
  });
  const na = norm(a);
  const nb = norm(b);
  return (
    na.connectionString === nb.connectionString &&
    na.host === nb.host &&
    na.port === nb.port &&
    na.database === nb.database &&
    na.user === nb.user &&
    na.password === nb.password &&
    na.readOnly === nb.readOnly &&
    JSON.stringify(normalizedSsh(a)) === JSON.stringify(normalizedSsh(b))
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
  const connectBinding = useKeybindingStore(
    (s) => s.bindings["connection.connect"],
  );
  const savedConnections = useStore((s) => s.savedConnections);
  const loadSavedConnections = useStore((s) => s.loadSavedConnections);
  const connectTo = useStore((s) => s.connectTo);
  const reconnectSession = useStore((s) => s.reconnectSession);
  const lastConnection = useStore((s) => s.lastConnection);
  const reconnectError = useStore((s) => s.reconnectError);
  const renameLiveConnection = useStore((s) => s.renameLiveConnection);
  const setConnectionColor = useStore((s) => s.setConnectionColor);
  const setConnectionReadOnly = useStore((s) => s.setConnectionReadOnly);
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
  const [formTab, setFormTab] = useState<"connection" | "safety" | "ssh" | "color">("connection");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Trust-on-first-use state for the SSH tab's bastion host key. Re-probed
  // whenever the bastion host/port or auth method changes (see the effect
  // below) — the probe itself never authenticates, so this is cheap and
  // safe to re-run on every edit rather than gating it behind a button.
  const [sshProbe, setSshProbe] = useState<SshHostKeyProbe | null>(null);
  const [sshProbing, setSshProbing] = useState(false);
  const [sshProbeError, setSshProbeError] = useState<string | null>(null);
  const [sshTrusting, setSshTrusting] = useState(false);

  const params = useMemo(() => toParams(form), [form]);

  const hasInput =
    form.connectionString.trim() !== "" || form.host.trim() !== "";

  // Re-probes the bastion's host key whenever there's enough to probe with —
  // debounced, since this fires on every keystroke in the host field
  // otherwise. The probe itself never authenticates (see
  // `probe_ssh_host_key` on the backend), so re-running it on every edit
  // costs nothing beyond the TCP round trip.
  const sshBastionHost = form.sshBastionHost.trim();
  const sshBastionPort = form.sshBastionPort.trim();
  useEffect(() => {
    if (!form.sshEnabled || !sshBastionHost) {
      setSshProbe(null);
      setSshProbeError(null);
      return;
    }
    const port = sshBastionPort ? Number(sshBastionPort) : 22;
    if (!Number.isFinite(port) || port <= 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSshProbing(true);
      setSshProbeError(null);
      api
        .probeSshHostKey(sshBastionHost, port)
        .then((probe) => {
          if (!cancelled) setSshProbe(probe);
        })
        .catch((err) => {
          if (!cancelled) {
            setSshProbe(null);
            setSshProbeError(errorMessage(err));
          }
        })
        .finally(() => {
          if (!cancelled) setSshProbing(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [form.sshEnabled, sshBastionHost, sshBastionPort]);

  const trustSshHostKey = () => {
    if (!sshProbe || !sshBastionHost) return;
    const port = sshBastionPort ? Number(sshBastionPort) : 22;
    setSshTrusting(true);
    api
      .trustSshHostKey(sshBastionHost, port, sshProbe.fingerprint)
      .then(() => setSshProbe((p) => (p ? { ...p, status: { status: "trusted" } } : p)))
      .catch((err) => setSshProbeError(errorMessage(err)))
      .finally(() => setSshTrusting(false));
  };

  const browseForPrivateKey = () => {
    void api.pickAndReadTextFile().then((picked) => {
      if (!picked) return;
      const filename = picked.path.split(/[/\\]/).pop() ?? picked.path;
      setForm((f) => ({ ...f, sshKeyContents: picked.contents, sshKeyFilename: filename }));
    });
  };

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
      // Likewise for color/style and read-only — Update alone (unlike
      // Connect/Reconnect) doesn't otherwise touch the live slot, so an edit
      // to an already-saved, already-live connection wouldn't show up until
      // a separate reconnect. Read-only specifically can't wait for that:
      // it's a safety switch, and a reconnect-shaped delay between "I turned
      // this on" and it actually taking effect is exactly the gap a safety
      // switch shouldn't have.
      const liveEntry = Object.entries(useStore.getState().connections).find(
        ([, slot]) => slot.current.connectionId === saved.id,
      );
      if (mode === "update" && liveEntry) {
        await setConnectionColor(liveEntry[0], color, colorStyle);
        await setConnectionReadOnly(liveEntry[0], form.readOnly);
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
    if (!e.repeat && matchesKeybinding(e, connectBinding) && hasInput && !connecting) {
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
                className={"settings-subtab" + (formTab === "safety" ? " settings-subtab--active" : "")}
                onClick={() => setFormTab("safety")}
              >
                Safety
              </button>
              <button
                type="button"
                className={"settings-subtab" + (formTab === "ssh" ? " settings-subtab--active" : "")}
                onClick={() => setFormTab("ssh")}
              >
                SSH Tunnel
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
                className={"conn-form-tabpage" + (formTab === "safety" ? "" : " conn-form-tabpage--hidden")}
              >
                <div className="conn-field">
                  <div className="conn-color-style">
                    <span>Read-only connection</span>
                    <Toggle
                      on={form.readOnly}
                      onToggle={() => {
                        setForm((f) => ({ ...f, readOnly: !f.readOnly }));
                        setTest({ kind: "idle" });
                        setConnectError(null);
                      }}
                    />
                  </div>
                  <p className="conn-readonly-hint">
                    Blocks every insert, update, and delete on this connection —
                    enforced by CubbyDB itself, not just the database role's own
                    grants. Independent of whatever the database role itself
                    allows — this protects a connection you <i>can</i> write to
                    but want to guard against your own mistakes on, like a
                    shared staging or production database.
                  </p>
                </div>
              </div>

              <div
                className={"conn-form-tabpage" + (formTab === "ssh" ? "" : " conn-form-tabpage--hidden")}
              >
                <div className="conn-field">
                  <div className="conn-color-style">
                    <span>Connect through an SSH bastion</span>
                    <Toggle
                      on={form.sshEnabled}
                      onToggle={() => {
                        setForm((f) => ({ ...f, sshEnabled: !f.sshEnabled }));
                        setTest({ kind: "idle" });
                        setConnectError(null);
                      }}
                    />
                  </div>
                  <p className="conn-readonly-hint">
                    For a database that isn't reachable directly — CubbyDB opens an
                    SSH connection to the bastion first, then routes the Postgres
                    connection through it. Host/Port on the Connection tab are the
                    real database, as reachable <i>from</i> the bastion.
                  </p>
                </div>

                {form.sshEnabled && (
                  <>
                    <div className="conn-row conn-row--host">
                      <Field
                        label="Bastion host"
                        value={form.sshBastionHost}
                        onChange={(v) => update("sshBastionHost", v)}
                        placeholder="bastion.example.com"
                      />
                      <Field
                        label="Bastion port"
                        value={form.sshBastionPort}
                        onChange={(v) => update("sshBastionPort", v)}
                        placeholder="22"
                      />
                    </div>

                    <Field
                      label="Bastion user"
                      value={form.sshBastionUser}
                      onChange={(v) => update("sshBastionUser", v)}
                      placeholder="ubuntu"
                    />

                    <label className="conn-field">
                      <span className="caption">Authentication</span>
                      <select
                        className="conn-input"
                        value={form.sshAuthMethod}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            sshAuthMethod: e.target.value as FormState["sshAuthMethod"],
                          }))
                        }
                      >
                        <option value="password">Password</option>
                        <option value="privateKey">Private key</option>
                        <option value="agent">SSH agent</option>
                      </select>
                    </label>

                    {form.sshAuthMethod === "password" && (
                      <Field
                        label="Bastion password"
                        type="password"
                        value={form.sshPassword}
                        onChange={(v) => update("sshPassword", v)}
                        placeholder="••••••••••"
                      />
                    )}

                    {form.sshAuthMethod === "privateKey" && (
                      <>
                        <label className="conn-field">
                          <span className="caption">Private key</span>
                          <div className="conn-key-row">
                            <button
                              type="button"
                              className="conn-key-browse"
                              onClick={browseForPrivateKey}
                            >
                              Browse…
                            </button>
                            <span className="conn-key-filename">
                              {form.sshKeyFilename ||
                                (form.sshKeyContents ? "Key loaded" : "No file selected")}
                            </span>
                          </div>
                        </label>
                        <Field
                          label="Key passphrase (if any)"
                          type="password"
                          value={form.sshKeyPassphrase}
                          onChange={(v) => update("sshKeyPassphrase", v)}
                          placeholder="••••••••••"
                        />
                        <p className="conn-readonly-hint">
                          Stored in plaintext alongside your other saved connection
                          details, same as a password — a leaked key's reach extends
                          beyond just this database, so treat this connection's
                          storage accordingly.
                        </p>
                      </>
                    )}

                    {form.sshAuthMethod === "agent" && (
                      <p className="conn-readonly-hint">
                        SSH agent authentication isn't supported yet — use a
                        password or private key for now.
                      </p>
                    )}

                    <SshHostKeyStatusPanel
                      probing={sshProbing}
                      probe={sshProbe}
                      error={sshProbeError}
                      trusting={sshTrusting}
                      onTrust={trustSshHostKey}
                    />
                  </>
                )}
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

/**
 * Trust-on-first-use status for the SSH tab's bastion host key. `probe` is
 * `null` while there's nothing to show yet (no bastion host typed, or a
 * probe still in flight) — `probing`/`error` cover those two cases
 * separately since "still checking" and "couldn't check" read very
 * differently to the user.
 */
function SshHostKeyStatusPanel({
  probing,
  probe,
  error,
  trusting,
  onTrust,
}: {
  probing: boolean;
  probe: SshHostKeyProbe | null;
  error: string | null;
  trusting: boolean;
  onTrust: () => void;
}) {
  if (probing && !probe) {
    return (
      <div className="conn-ssh-hostkey conn-ssh-hostkey--pending">
        <Spinner /> Checking the bastion&rsquo;s host key…
      </div>
    );
  }
  if (error) {
    return <div className="conn-ssh-hostkey conn-ssh-hostkey--error">{error}</div>;
  }
  if (!probe) return null;

  if (probe.status.status === "trusted") {
    return (
      <div className="conn-ssh-hostkey conn-ssh-hostkey--trusted">
        ✓ Host key verified ({probe.keyType} {probe.fingerprint})
      </div>
    );
  }

  if (probe.status.status === "changed") {
    return (
      <div className="conn-ssh-hostkey conn-ssh-hostkey--danger">
        <p>
          <b>The bastion&rsquo;s host key has changed.</b> It was previously trusted as{" "}
          <code>{probe.status.previousFingerprint}</code>, but is now presenting{" "}
          <code>{probe.fingerprint}</code> ({probe.keyType}). This could mean the
          bastion was reconfigured — or that something is impersonating it.
        </p>
        <button
          type="button"
          className="conn-ssh-hostkey__trust conn-ssh-hostkey__trust--danger"
          onClick={onTrust}
          disabled={trusting}
        >
          {trusting ? "Trusting…" : "I've verified this — trust the new key"}
        </button>
      </div>
    );
  }

  // "unknown" — never seen this bastion before.
  return (
    <div className="conn-ssh-hostkey conn-ssh-hostkey--unknown">
      <p>
        New bastion. <b>{probe.keyType}</b> host key fingerprint:{" "}
        <code>{probe.fingerprint}</code>
      </p>
      <button
        type="button"
        className="conn-ssh-hostkey__trust"
        onClick={onTrust}
        disabled={trusting}
      >
        {trusting ? "Trusting…" : "Trust and continue"}
      </button>
    </div>
  );
}
