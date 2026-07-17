# CubbyDB

A modern, restrained desktop Postgres client. Neutral surfaces, hairline
borders, and a single indigo accent reserved for actions and active state.
Built with Tauri (Rust) + React + TypeScript.

> Status: early v1. The core loop works end to end — connect, browse the schema,
> run a query, and see results. See [Roadmap](#roadmap) for what is intentionally
> not built yet.

## Features

Implemented in this milestone:

- **Connection management** — connect by connection string or individual
  host / port / database / user / password fields, with a "Test connection"
  action. Connections are saved to a local JSON file and listed on launch.
- **Schema browser** — schemas, tables/views, and columns (with types and
  primary-key markers) read from the Postgres catalog and rendered as a
  collapsible sidebar tree. Right-click (or double-click) a table for
  "Select top 100".
- **SQL editor** — CodeMirror 6 with Postgres syntax highlighting, multiple
  tabs, and Cmd/Ctrl+Enter to run. Errors from Postgres are shown inline near
  the editor, never in a modal.
- **Results grid** — tabular results with a default `LIMIT 100` applied to
  unbounded `SELECT`s, numeric columns right-aligned, and an "Export CSV"
  action.
- **Query history** — every executed query is logged locally with a timestamp;
  a side panel browses and re-runs past queries.

Not built yet (planned): inline cell editing with generated `UPDATE`s, and the
no-SQL table browser. See [Roadmap](#roadmap).

## Tech stack

| Layer      | Choice                                                    |
| ---------- | --------------------------------------------------------- |
| Shell      | [Tauri 2](https://tauri.app) (Rust)                       |
| Frontend   | React 18 + TypeScript + [Vite](https://vite.dev)          |
| Editor     | [CodeMirror 6](https://codemirror.net)                    |
| State      | [Zustand](https://github.com/pmndrs/zustand)              |
| DB driver  | [tokio-postgres](https://docs.rs/tokio-postgres) + native-tls |

## Architecture

The guiding principle is that **all database-specific logic lives behind one
driver interface in the Rust backend**, so a second engine could be added later
without touching the UI.

- `src-tauri/src/db/mod.rs` defines the engine-agnostic types
  (`ConnectionParams`, `SchemaNode`, `QueryResult`, ...) and the
  `DatabaseDriver` / `DbSession` traits.
- `src-tauri/src/db/postgres.rs` is the only module that depends on
  `tokio-postgres`. Result values are read with `simple_query`, which returns
  every value in its canonical text form — so the grid needs no per-type
  conversion code.
- The **frontend never constructs SQL** except the user's own editor text. The
  default `LIMIT` for unbounded selects and the "Select top 100" statement are
  both generated in the backend (`src-tauri/src/commands.rs`).

```
src-tauri/src/
  db/
    mod.rs          driver interface + shared types
    postgres.rs     Postgres implementation
    error.rs        structured DbError (carries SQLSTATE, hint, position)
  connections.rs    saved-connection persistence (JSON)
  history.rs        query history log (JSONL)
  state.rs          Tauri-managed app state (one active session)
  commands.rs       the command surface exposed to the frontend
  lib.rs / main.rs  app wiring + entry point

src/
  api/backend.ts    typed wrappers over the Tauri commands (the only bridge)
  state/store.ts    Zustand store + backend orchestration
  components/
    connection/     the connection screen
    workspace/      top bar, schema tree, editor tabs, editor, results, history
    common/         shared frame / spinner / button styles
  styles/tokens.css design tokens transcribed from the design spec
```

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable) and the platform toolchain Tauri requires
  (on macOS: the Xcode command line tools)

## Development

```bash
npm install         # install frontend dependencies
npm run app         # launch the desktop app (Tauri dev)
```

Other useful scripts:

```bash
npm run dev         # frontend only, in the browser (backend commands unavailable)
npm run build       # type-check + build the frontend bundle
npm run app:build   # produce a distributable desktop build
```

Rust unit tests:

```bash
cd src-tauri && cargo test
```

There is also a live end-to-end smoke test, ignored by default. Point it at a
throwaway database:

```bash
cd src-tauri
CUBBYDB_TEST_DSN="postgresql://user@localhost:5432/your_db" \
  cargo test --lib -- --ignored --nocapture
```

## Data & files

CubbyDB stores everything under the OS app-data directory
(`~/Library/Application Support/com.cubbydb.app` on macOS):

- `connections.json` — saved connections
- `history.jsonl` — query history

**Security note:** in this version, saved connection passwords are written to
`connections.json` in plaintext (the file is created with `0600` permissions on
Unix). Moving secrets to the OS keychain is planned. Don't save credentials you
wouldn't keep in a local dotfile.

## Roadmap

Deliberately out of scope for v1: autocomplete/IntelliSense, engines other than
Postgres, multiple simultaneous connections, accounts/sync/cloud, and release
automation. Planned next steps within v1:

- Inline cell editing → backend-generated `UPDATE` scoped by primary key
  (read-only cells, with a note, when a table has no detectable key).
- The no-SQL table browser (design screen 04).
- Moving saved-connection secrets into the OS keychain.

## License

MIT — see [LICENSE](LICENSE).
