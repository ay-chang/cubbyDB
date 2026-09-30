# CubbyDB

A modern, restrained desktop Postgres client. Neutral surfaces, hairline
borders, and a user-selectable accent color (20 presets, default green) used
consistently for actions and active state. Built with Tauri (Rust) + React +
TypeScript.

Connect → browse the schema → run SQL or browse tables with no SQL required →
edit rows inline → export, plus multiple simultaneous connections, saved
queries, cubbies (task-scoped collections of tables/queries/AI chats), query
history, a schema-aware SQL autocomplete and AI assistant, 8 themes, and a
signed auto-updater.

## Features

**[FEATURES.md](FEATURES.md) is the current, complete catalog of everything
CubbyDB does** — this README stays intentionally high-level so it doesn't
duplicate (and drift out of sync with) that list. Highlights:

- **Connections** — connection string or individual fields, saved locally,
  multiple live connections at once with independent tabs and schemas each
- **Schema browser** — tables, views, columns, functions, sequences, and enum
  types, plus a Cmd/Ctrl+K palette that searches across all of it
- **SQL editor** — CodeMirror 6, schema-aware autocomplete, paginated results,
  EXPLAIN/EXPLAIN ANALYZE, cancel-in-flight
- **No-SQL table browsing** with inline cell editing (backend-generated
  `UPDATE`s scoped by primary key) and row insert/delete
- **Saved queries** and **cubbies** — a cubby is a named collection of
  references (tables, saved queries, AI chats, structure/function/sequence
  views) for one task, so opening it restores everything you were using
- **AI assistant** — schema-aware chat with Anthropic, OpenAI, or Codex/Claude
  Code subscription login; read-only by construction
- Query history, keyboard-shortcut rebinding, 8 themes, and a signed
  in-app auto-updater
- **Paid app** — a 7-day free trial, then a one-time license key bought on
  [cubbydb.com/pricing](https://cubbydb.com/pricing) (sold through Polar)

## Tech stack

| Layer      | Choice                                                    |
| ---------- | --------------------------------------------------------- |
| Shell      | [Tauri 2](https://tauri.app) (Rust)                       |
| Frontend   | React 18 + TypeScript + [Vite](https://vite.dev)          |
| Editor     | [CodeMirror 6](https://codemirror.net)                    |
| State      | [Zustand](https://github.com/pmndrs/zustand)               |
| DB driver  | [tokio-postgres](https://docs.rs/tokio-postgres) + native-tls |
| AI         | Anthropic / OpenAI APIs, plus Codex CLI and Claude Code CLI subscription login |

## Architecture

The guiding principle is that **all database-specific logic lives behind one
driver interface in the Rust backend** (`src-tauri/src/db/`), so a second
engine could be added later without touching the UI. The **frontend never
constructs SQL** except the user's own editor/filter text — generated SQL
(default `LIMIT`, "select top 100", inline-edit `UPDATE`s) is built in Rust
and exposed through a typed Tauri command surface (`src/api/backend.ts` is the
only bridge to it).

See [AGENTS.md](AGENTS.md) for the exact repository layout and the rules that
govern it — it's kept current for that purpose; this README doesn't duplicate
it.

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
npm test            # frontend unit tests (Vitest)
npm run lint        # ESLint
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
- `open_connections.json` — currently-open connections, for auto-reconnect
- `history.jsonl` — query history
- `saved_queries.json` — saved queries
- `cubbies.json` — cubbies
- `ai_config.json` — AI provider/model settings
- `ai_chats.json` — saved AI conversations, per connection
- `license.json` — the activated license key, if any
- `trial.json` — when this install's 7-day trial started (also mirrored in
  the OS cache directory, so deleting this file alone doesn't reset it)

Query results, schema, and table row counts are **not** persisted — always
read live from Postgres.

**Security note:** saved connection passwords (and AI API keys) are stored in
plaintext, with the file created at `0600` permissions on Unix. This is a
deliberate, permanent choice, not a gap being closed — see AGENTS.md's
Gotchas section for why an OS-keychain round trip (multiple auth prompts per
launch) wasn't worth the trade. Don't save credentials you wouldn't keep in a
local dotfile.

## Licensing (how the paywall works)

CubbyDB is sold, not free. The logic lives in `src-tauri/src/license.rs`:

- **Trial:** the first launch records a start date. For 7 days everything
  works; the top bar shows "Trial: N days left". After that the whole app is
  replaced by the lock screen (`LicenseGate`) until a key is activated.
- **Buying:** Buy opens [cubbydb.com/pricing](https://cubbydb.com/pricing),
  which links to the Polar checkout. Polar emails a `CUBBY-...` license key.
- **Activating:** Settings → License (or the lock screen) sends the key to
  Polar's public license API, which allows up to 3 activations per key. The
  key and its activation id are saved to `license.json`.
- **Re-checking:** about once a week the app re-validates the key with Polar
  in the background. A revoked or refunded key goes back to unlicensed;
  being offline never locks anyone out.
- **Removing:** Settings → License → Remove deactivates the key with Polar,
  freeing that computer's slot.
- **Free keys** (friends, early users) are Polar checkouts with a 100%
  discount code — there is no special case in the app.

The Polar organization id and pricing URL are constants at the top of
`license.rs`. The price itself lives only in Polar and on the website.

## Releasing

This repo is private, so installers can't be downloaded from it. CI builds
every release and publishes it to the public
[`ay-chang/cubbyDB-releases`](https://github.com/ay-chang/cubbyDB-releases)
repo instead. That's where the in-app updater (`tauri.conf.json`'s updater
endpoint) and the website's download buttons look for new versions.

To ship a new version:

1. Add a `RELEASE_NOTES` entry for the new version at the top of
   `src/lib/releaseNotes.ts` (shown once in the app's What's New tab), and
   the same entry at the top of `src/lib/changelog.ts` in the `cubbydb-site`
   repo (the public cubbydb.com/changelog page).
2. Bump the version, commit, tag, and push:

   ```bash
   node scripts/set-version.mjs X.Y.Z
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

3. The `release` workflow builds macOS, Windows, and Linux installers and
   creates a **draft** release on `cubbyDB-releases`. Review it there and
   click **Publish release**. Only then do users get the update and the
   website serve the new download.

One-time setup (already done unless you're setting this up fresh): the
workflow needs these secrets on this repo — `RELEASES_TOKEN` (a fine-grained
GitHub token with Contents read/write on `cubbyDB-releases`), the Tauri
updater signing key (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and the Apple signing and
notarization secrets (`APPLE_*`). See the header of
`.github/workflows/release.yml`.

## Scope

Explicitly out of scope: any database engine other than Postgres, and user
accounts/sync/cloud features. See [AGENTS.md](AGENTS.md#status--scope) for the
current, maintained version of this list — kept there rather than here so it
has one place to go stale, not two.

## License

Proprietary — see [LICENSE](LICENSE).
