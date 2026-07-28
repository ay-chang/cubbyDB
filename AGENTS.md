# AGENTS.md — CubbyDB

Context and conventions for AI coding agents working in this repository. Read
this before making changes. For user-facing docs see [README.md](README.md);
for a catalog of what's built see [FEATURES.md](FEATURES.md).

## What this is

CubbyDB is a **desktop Postgres client** — a native app (Tauri) with a React UI.
It connects to a Postgres database, browses its schema, runs SQL, and shows
results. The visual design is deliberate and specific (see
[Design](#design-system)); match it, don't reach for generic component-library
styling.

Product name is **CubbyDB**. The original design mockup called it "Halyard" —
ignore that name.

## Status & scope

This is an early v1, but the core loop and most of a usable Postgres client are
built: connect → browse schema → run a query → edit/insert/delete rows →
export, plus query history, tab persistence, auto-reconnect, and a full
Settings system (theme, table/editor appearance, general behavior).

**[FEATURES.md](FEATURES.md) is the living, user-facing catalog of everything
that's built — read it instead of trusting this section to be current.**

**Explicitly OUT of scope — do not build:**
- Autocomplete / IntelliSense in the editor
- Any database engine other than Postgres
- Multiple simultaneous open connections
- User accounts, sync, or cloud features
- CI/CD, code signing, release automation

## Architecture — the rules that matter

1. **All database-specific logic lives behind one driver interface** in the Rust
   backend (`src-tauri/src/db/`). `db/mod.rs` defines engine-agnostic types and
   the `DatabaseDriver` / `DbSession` traits; `db/postgres.rs` is the *only*
   file that depends on `tokio-postgres`. A second engine would be a new module
   implementing those traits plus one arm in `driver_for` — no UI changes.

2. **The frontend never constructs SQL** except the user's own editor text (and
   the WHERE-filter text, which is likewise user-authored). Generated SQL — the
   default LIMIT on unbounded SELECTs, "select top 100", the filtered
   table query — is built in Rust (`db/postgres.rs`, exposed via
   `commands.rs`).

3. **Errors are data, shown inline — never modal.** The backend returns a
   structured `DbError` (message + SQLSTATE + hint + position). The UI renders it
   as a calm strip where results would appear. Preserve this.

4. **No emojis** anywhere in console output, logs, or error messages.

## Repository layout

```
src-tauri/src/
  db/
    mod.rs          driver interface + neutral types (ConnectionParams,
                    SchemaNode, QueryResult, ...)
    postgres.rs     Postgres impl. Reads result values with `simple_query`
                    (Postgres returns canonical text for every type, so no
                    per-type conversion is needed). Also: default-LIMIT logic,
                    select-top/filter SQL generation, error mapping.
    error.rs        DbError { message, code, hint, position, kind }
  connections.rs    saved connections + "last connection" (JSON, 0600 on unix)
  history.rs        query history log (JSONL, size-capped)
  state.rs          Tauri-managed AppState (ONE active session at a time)
  commands.rs       the #[tauri::command] surface; also the auto-reconnect retry
  lib.rs / main.rs  app wiring + entry point

src/
  api/backend.ts    typed wrappers over Tauri commands — the ONLY bridge to Rust
  state/store.ts    Zustand store; orchestrates backend calls; tab persistence
  types.ts          TS mirrors of the Rust types (serialized camelCase)
  components/
    connection/     connection screen
    workspace/      TopBar, SchemaTree, EditorTabs, SqlEditor, ResultsPane,
                    FilterBar, HistoryPanel, Workspace
    common/         AppFrame, Spinner, shared button/frame styles
  styles/tokens.css design tokens (see below)
```

## Design system

Transcribed in `src/styles/tokens.css`. Light theme, hairline borders, a single
indigo accent reserved for actions and active state. 4px base unit.

- Fonts: **Geist** (UI), **Geist Mono** (code, values, labels)
- Accent: `#5E6AD2` (indigo). Success `#1F9D57`, error `#E5484D`, amber `#B45309`
- Surfaces: app bg `#F7F8F8`, surface `#FFFFFF`, raised `#FCFCFD`
- Borders are 1px hairlines (`#E8EAED`), never shadows/bevels between panes
- Radius: 6–7px controls, 12px cards. Transition 120ms ease.
- Editor syntax: keywords accent, strings green, numbers amber, comments gray

The source design lives at `~/Downloads/cubbydb/project/` (the v1 file,
`Postgres Client - Design Spec.dc.html`, is authoritative; the "v2 exploration"
was rejected because it removes the sidebar). Screenshots are not needed —
values are in the spec/tokens.

## Running & testing

```bash
npm install
npm run app         # launch the desktop app (Tauri dev). First launch compiles
                    # Rust (~30s); frontend hot-reloads after.
npm run build       # type-check + build the frontend
cd src-tauri && cargo build     # compile the backend
cd src-tauri && cargo test      # Rust unit tests
```

Live end-to-end backend test (ignored by default; needs a database):
```bash
cd src-tauri
CUBBYDB_TEST_DSN="postgresql://user@localhost:5432/db" \
  cargo test --lib -- --ignored --nocapture
```

Note: **Rust/config changes require a full app restart** (quit + `npm run app`);
frontend-only changes hot-reload. `tauri.conf.json`, new commands, and anything
in `src-tauri/` are Rust-side.

## Conventions

- **Document every feature you build in [FEATURES.md](FEATURES.md).** When you
  ship something user-facing — a new capability, a new Settings option, a
  meaningful change to how an existing feature behaves — add or update its
  entry there in the same change. Write what it does, not how (implementation
  detail belongs in code comments or this file's architecture sections).
  FEATURES.md is the source of truth for "what does CubbyDB do"; don't let it
  drift like the old inline status list did.
- **Document every keyboard shortcut in Settings > Keyboard Shortcuts.** When
  you add, change, or remove a shortcut anywhere in the app, update
  `SHORTCUT_GROUPS` in `src/components/common/SettingsDialog.tsx` in the same
  change — add it to whichever group matches its scope (General, SQL editor,
  Results grid, Command palette, ...), or start a new group if it doesn't fit
  an existing one. That list is meant to be the complete, always-current
  catalog of every shortcut CubbyDB supports; don't let it drift.
- Rust ↔ TS types are serialized **camelCase** (`#[serde(rename_all =
  "camelCase")]`). Keep `types.ts` in sync with `db/mod.rs` and the stores.
- Tauri command args map JS camelCase ↔ Rust snake_case automatically.
- Keep new persistence in the OS app-data dir via `AppState`, not scattered.
- Verify changes with `npm run build` + `cargo build`; the user prefers NOT
  opening the browser preview pane.

## Gotchas / non-obvious behavior

- **Neon / serverless**: idle computes suspend and the connection drops.
  `commands.rs` detects a dropped-connection `DbError` (kind `Connection`, set
  when tokio-postgres reports the socket closed) and **transparently reconnects
  and retries once** for `run_query` and `fetch_schema`. `ActiveSession` stores
  the params so it can rebuild. Preserve this — it's what makes reconnect seamless.
- **StrictMode**: `store.initialize()` is guarded by a module-level `didInitialize`
  flag so React's dev double-invoke doesn't open two connections.
- **Auto-reconnect on launch**: the last successful connection is saved to
  `last_connection.json`; on launch the app reconnects automatically and restores
  open tabs (table tabs re-run their query; query tabs restore SQL only).
  Explicit Disconnect clears the last connection (opts out).
- **TLS**: native-tls with sslmode=prefer — TLS when the server offers it,
  plaintext otherwise. No extra system deps.
- **Passwords are stored in plaintext** in `connections.json` /
  `last_connection.json` (0600). Known limitation; OS keychain is the planned fix.
  Don't regress to logging them.
- Tab layout, and per-table column order/width, are persisted in the webview's
  `localStorage` (keys prefixed `cubbydb:`).

## Data on disk

`~/Library/Application Support/com.cubbydb.app/` (macOS):
- `connections.json` — saved connections
- `last_connection.json` — last connection, for auto-reconnect
- `history.jsonl` — query history (capped to ~1000 recent entries)

Query results, schema, and table row counts are **not** persisted — always read
live from Postgres.
