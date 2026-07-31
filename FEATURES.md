# CubbyDB Features

A catalog of what's actually built, from the user's point of view. This is the
source of truth for "what does CubbyDB do" — keep it current. **Whenever you
ship a feature, add it here** (see AGENTS.md's Conventions section).

Each entry is what the feature does, not how — implementation notes belong in
code comments or AGENTS.md's architecture section.

## Connections

- Connect via a full connection string, or individual fields (host, port,
  database, user, password)
- Test a connection before connecting or saving
- A **Name** field on the form controls what a saved connection is called —
  it's independent of the database/host, defaulting to a placeholder
  auto-derived from them (database name, then host, then a parsed-out
  connection-string segment) if left blank
- Save, rename, and delete named connections; shown as cards you can click to
  reload into the form
- Clicking a saved card loads it (name included) into the form and keeps it
  selected even as you edit fields; an "Editing X" note appears, and editing
  either the name or the connection details enables both **Update**
  (overwrites the selected connection) and **Save as new** (creates a
  separate connection, leaving the original untouched) — so which one you're
  about to do is always explicit, never inferred silently. Renaming a
  connection that's currently live updates its name in the top bar's
  connection switcher immediately, without needing to reconnect
- **Duplicate** a saved card (⧉ icon, next to Delete) to clone it into a new
  saved connection pre-loaded in the form, ready to tweak (e.g. cloning a
  prod connection to make a staging one)
- **Multiple connections at once**: connecting never closes another live
  connection — the "+" in the top bar's connection switcher opens a form for
  an *additional* database. Every open connection's session, tabs, and schema
  tree stay alive in the background; a row of pills in the top bar lets you
  jump between their workspaces instantly (no reconnect). Each pill has its
  own "×" to close just that connection without switching to it first, and
  the top bar's Disconnect button closes whichever one is currently visible.
  Only the most-recently-used connection is restored automatically on
  launch — additional connections from a previous session aren't reopened
  and start fresh each time
- **Edit the connection you're on** — a ✎ icon on each pill in the switcher
  opens the same form pre-filled with that session's actual name and
  connection details (works even if it was never saved). Hitting **Reconnect**
  applies the edit to that same session in place — same tabs, same slot,
  just pointed at the new details — rather than opening another connection.
  If it came from a saved connection, that saved record is kept in sync too;
  if it didn't (an ad-hoc connection typed in directly), **Save** persists it
  as a new saved connection independently of reconnecting
- Auto-reconnect on launch to the last-used connection; if it fails, the
  connect screen opens pre-filled with the reason
- If a query or schema fetch fails because a connection silently dropped
  (e.g. a Neon serverless compute suspending), CubbyDB reconnects and retries
  once automatically — independently per connection, so one dropping doesn't
  affect the others
- Cmd/Ctrl+Enter connects from the form
- Disconnecting a connection clears the launch auto-reconnect target only
  once every connection is closed — closing one of several open connections
  leaves the others as the target for next launch
- **Passwords are stored in plaintext** in the saved-connections JSON file
  (`0600` permissions on Unix, the only real protection). An earlier version
  stored them in the OS keychain instead, but every OS keychain treats each
  lookup *and* each store as its own access request with its own
  authorization prompt — connecting to a saved database, or just restarting
  the app, could mean several password prompts in a row. Anyone upgrading
  from that version gets a one-time pull-back: the first time each saved (or
  last-used) connection is read, its password is pulled out of the keychain
  into this file and the keychain entry is deleted, so it's never touched
  again after that

## Schema browser

- Collapsible tree: schemas → tables/views → columns
- Filter box — matches schema, table, or column names
- Compact row-count badge per table/view (e.g. "1.2M", "88k")
- Click a table/view to browse its rows in a new tab (or focus the existing
  one if already open)
- Right-click a table for a context menu ("Select top 100")
- Expand a table in the tree to see its columns, with a primary-key badge
- **Functions, sequences, and enum types**, each in their own collapsible
  group per schema (default collapsed, shown only when non-empty — keeps a
  schema with lots of extension-installed functions from cluttering the
  Tables list). Functions/procedures show their argument signature inline;
  clicking one opens a read-only tab with its full body via Postgres's own
  `pg_get_functiondef()`, syntax-highlighted like the SQL editor — accurate
  regardless of language (SQL, PL/pgSQL, ...). Sequences show which
  table/column they're `OWNED BY`, if any; clicking one opens its current
  value, min/max, increment, and cache size, straight from Postgres's own
  `pg_sequences` view. Enum types expand inline to show their values, the
  same interaction as expanding a table to see its columns — no tab needed.
  Aggregate/window functions, and composite/domain types, are out of scope
  for now — regular functions/procedures and enums cover the common case
- The top bar's **Refresh** button visibly confirms it ran: it shows a
  spinner + "Refreshing…" while the schema reloads, then briefly flashes
  "Refreshed ✓" — so even a near-instant refresh (the common case) is
  never silently indistinguishable from a no-op
- **Cmd/Ctrl+K quick-jump**: fuzzy-search every table and column across
  *every open connection* — not just the visible one, so searching while
  staging and prod are both connected finds either. With nothing typed it
  lists every table (grouped by connection, then alphabetically); typing
  narrows to fuzzy-matching tables *and* columns together across all of
  them, ranked by match quality, with the matched characters highlighted.
  Each result is tagged with which connection it's from (a small badge,
  shown only once more than one connection is open — no clutter with just
  one). Enter (or click) on a table opens/focuses its browse-rows tab — the
  same as clicking it in the sidebar; on a column, it opens/focuses that
  table's **structure** tab and scrolls to + briefly flashes that column's
  row there, since structure is the closest thing to a column's
  "definition" to jump to. Jumping to a result on a different connection
  switches to it first (same as clicking its pill in the top bar)

## SQL editor

- CodeMirror 6 with Postgres syntax highlighting (keywords, strings, numbers,
  comments)
- **Schema-aware autocomplete**, sourced from the active connection's live
  schema tree: table names after `FROM`/`JOIN`, and column names after
  `alias.` — resolved from the query's own `FROM`/`JOIN` clauses, so it knows
  which table an alias refers to. Matching is fuzzy (what you've typed
  doesn't need to be an exact prefix), and **Tab** accepts the highlighted
  suggestion; Enter/↑/↓/Escape work as usual while the popup is open.
  Keyword suggestions are a small curated list of common clause words
  (`SELECT`, `WHERE`, `JOIN`, `GROUP BY`, `ILIKE`, ...) rather than
  `@codemirror/lang-sql`'s full ~600-word dialect dictionary — that list
  includes obscure system-catalog and XML-function terms that would
  otherwise fuzzy-match so much of what you type that they bury the schema
  suggestions that are actually useful
- Multiple tabs; drag to reorder; "+" to add, click to close.
  Cmd/Ctrl+T opens a new tab and Cmd/Ctrl+W closes the active one from
  anywhere in the workspace (both route through the same unsaved-edits
  confirmation as the tab-strip's own "+"/"×")
- **Cmd/Ctrl+Enter** runs the selection if you have one, otherwise the SQL
  statement your cursor is in — not the whole buffer. **Cmd/Ctrl+Shift+Enter**
  always runs the entire tab. (When the editor isn't focused, Cmd/Ctrl+Enter
  falls back to running the whole tab, since there's no cursor to go by.)
  Statement splitting is a lightweight scanner, not a full SQL parser: it
  understands quoted strings and comments but not Postgres's `$$...$$`
  dollar-quoting, so a multi-statement script containing a dollar-quoted
  function body should be run as a whole rather than statement-by-statement
- **Cmd/Ctrl+Shift+E** runs `EXPLAIN` and **Cmd/Ctrl+Shift+A** runs
  `EXPLAIN ANALYZE` on the same selection-or-statement-at-cursor target as
  Cmd/Ctrl+Enter — the plan comes back through the same results grid as any
  other query (Postgres's own `"QUERY PLAN"` column is a visual cue it's a
  plan, not a normal result set), so it's searchable, copyable, and
  exportable for free. `EXPLAIN ANALYZE` actually executes the statement —
  real side effects for DML — same as running it directly with no confirm
  prompt, so there isn't one for `EXPLAIN ANALYZE` either
- **Cancel a running query** — a Cancel button appears in the results header
  while a query runs, and Escape cancels it too. Scoped to the currently
  visible connection (one query executing at a time per connection): it
  interrupts whatever's actually running on that connection's server right
  now via Postgres's own cancel-request protocol, and comes back as a normal
  query error (SQLSTATE `57014`) — a query running in a background
  connection isn't affected
- Font family, font size, and line-wrap are all configurable
  (Settings → Appearance → Editor)
- New tabs open with a configurable starter-SQL placeholder
  (Settings → General)

## Saved queries

- Save the active query tab as a named, persistent "saved query" —
  **Cmd/Ctrl+S** (or the save icon on the active query tab) opens a small
  dialog to name it. Global, not tied to a connection — a saved query is
  meant to be reusable across databases with the same shape (e.g. staging
  vs prod), the same reasoning Cmd+K quick-jump already searches across
  every open connection
- Distinct from the existing "restore tabs on launch": that's an unnamed,
  un-curated snapshot of whatever tabs happened to be open, for the one
  auto-reconnected connection. This is explicit and named — you choose what
  to save, and it's there in the **Saved** panel regardless of which
  connection you're on
- A tab that's already linked to a saved query shows a "✓" instead of the
  save icon; saving again **updates** that same record. A second **Save as
  new** option branches off a separate saved query instead, leaving the
  original untouched — the same explicit Update/Save-as-new split saved
  connections use
- The **Saved** panel (top bar, next to History) lists every saved query —
  name, a SQL preview, and when it was saved — with inline rename (✎) and
  delete. Clicking one opens it in a new tab (or focuses its already-open
  tab)

## Results grid

- Any query's result set: resizable columns, drag-to-reorder columns,
  per-column sort (click a header, cycles ascending → descending → none)
- Numeric columns are auto-detected and right-aligned in monospace
- A column too narrow for its content truncates with a visible "…" (a value's
  full text is still one hover away via its tooltip) rather than just
  clipping silently mid-character
- Foreign-key navigation: right-click a cell that references (or is
  referenced by) another row to jump straight to it, opening/focusing a table
  tab. The jump's filter column is double-quoted, so mixed-case column names
  (e.g. `employeeContactInformationId`, common with ORM-generated schemas
  like TypeORM/Prisma) resolve correctly instead of Postgres folding them to
  lowercase and reporting "column does not exist." The "rows referencing
  this" list is wide enough for most schema/table/column paths to read on one
  line and never wraps or silently truncates a name — anything still too
  long to fit is reachable by scrolling the list horizontally
- CSV export, with a configurable field delimiter
- **Find in results** (Cmd/Ctrl+F): a query box scoped to the active grid,
  matching case-insensitively against every existing-row cell. Matches are
  highlighted, the current one distinctly; Enter/Shift+Enter or the ‹ › in
  the find bar jump between them, scrolling the grid as needed. Draft/new
  rows aren't searched — they're few and already on-screen
- Font, font size, row height, zebra striping, cell borders (gridlines),
  header-row shading, text wrap-vs-truncate, and how NULL renders (literal
  text / dash / blank) are all configurable (Settings → Appearance → Table)

## Table browsing (no SQL required)

- Clicking a table opens a backend-generated `SELECT * ... LIMIT ... OFFSET
  ...` — the frontend never assembles this SQL itself
- A `WHERE` filter bar: type a predicate, press Enter/Apply; the backend
  rebuilds the query with it. Same schema-aware autocomplete as the SQL
  editor (fuzzy match, Tab to accept), scoped to just this table — so a bare
  column name (e.g. `pri` → `price`) completes directly with no alias needed.
  Keyword suggestions here are an even smaller curated set — just the
  operators/connectives a single predicate actually uses (`AND`, `OR`,
  `IS`, `NULL`, `LIKE`, `ILIKE`, `BETWEEN`, ...)
- Pagination — 500 rows per page, Prev/Next; changing the filter resets to
  page 1

## Table structure

- Right-click a table in the schema tree → "View structure" opens a read-only
  tab showing its **columns** (type, nullable, default expression, primary/
  foreign-key badges), **indexes**, and **check constraints**
- Foreign-key badges are merged in from the schema tree's own data; index and
  check-constraint text comes straight from Postgres's own `pg_indexes` /
  `pg_get_constraintdef` rather than being reconstructed by hand, so it's
  always accurate
- Deliberately does **not** generate a full `CREATE TABLE` statement — storage
  params, partitioning, and generated/identity columns make a faithful
  reconstruction genuinely complex; the structured columns/indexes/constraints
  view covers the common "what does this table look like" need instead

## Inline cell editing

- Double-click any cell to edit it in place — including primary-key cells
- Unsaved edits are tracked per row (amber left-border + dot on dirty cells);
  a footer bar shows the change count with Discard / Update (Cmd/Ctrl+S)
- Update commits one row at a time as a backend-generated, primary-key-scoped
  `UPDATE`; editing requires the table to have a detected primary key
- Right-click a nullable cell to set it to `NULL`
- Right-click a cell with a pending edit for **Revert to original** — undoes
  just that one cell, leaving any other pending edits on the row (or other
  rows) untouched, unlike Discard which clears everything at once
- **Add row**: appends a blank draft row (unset cells read "default"),
  inserted as an `INSERT` on commit — or `INSERT ... DEFAULT VALUES` if left
  entirely blank
- **Remove row(s)**: deletes one or more selected existing rows (a single
  confirmation covers a multi-row selection) via a primary-key-scoped
  `DELETE`
- **Cascading delete preview**: if other rows reference the one(s) you're
  deleting via a foreign key, deleting shows exactly what else would go
  instead of just failing with a raw constraint error — every dependent row,
  grouped by table, walked transitively (dependents of dependents, e.g.
  deleting a customer also shows their orders *and* those orders' line
  items) — the same pattern Django's admin panel uses for this. Confirming
  deletes everything shown in one transaction: fully atomic, and either it
  all goes or none of it does. Capped at 5 levels deep / 500 total rows for
  safety — if a delete would exceed that, it's refused outright rather than
  run partially, with a message explaining why. Only handles foreign keys
  that reference a table's primary key (the overwhelming majority in
  practice); one that references some other unique constraint falls back to
  today's plain "delete this row?" confirmation
- **Import CSV**: "⇪ Import CSV" in a table tab's toolbar parses a CSV file
  client-side and adds its rows as draft rows — the exact same flow as Add
  row / paste, so nothing is inserted until you review them and hit Update.
  Header names are matched to table columns case-insensitively; unmatched CSV
  columns are ignored, and blank cells (or unmatched table columns) are left
  to the column's default, same as an unedited Add-row cell
- Any insert/update/delete failure — a constraint violation, an invalid
  value, a foreign-key conflict — surfaces in a dismissible banner with the
  database's own message, SQLSTATE code, and hint

## Row selection, copy & paste

- Click a cell to select it (now available to copy); double-click to edit
- Click a row's number, in the left gutter, to select the whole row —
  Shift-click extends a range, Cmd/Ctrl-click toggles individual rows into
  the selection
- Cmd/Ctrl+C copies the selected cell or row(s) to the OS clipboard
  (tab-separated by default; configurable — Settings → General)
- Cmd/Ctrl+V: with one row copied and one target row selected, overwrites
  the target's values (including the primary key — a conflict, e.g. a
  duplicate key, surfaces as an error rather than being silently avoided);
  with multiple copied rows, appends them as new draft rows to insert
  (duplicate-a-row flow)
- Copy is layered (copy-event injection, then a backend OS-clipboard
  command) so it works reliably inside the Tauri webview
- Selecting rows only shows the row-tint highlight — cell text itself never
  picks up the browser's native text-selection box, even when dragging across
  several rows (copy/paste still work exactly the same either way)

## Query history

- Every query — success or failure — is logged locally with its timestamp,
  row count, elapsed time, and (on failure) the error message
- Slide-in panel; click an entry to re-run it in a new tab
- Clearable; capped on disk (~1000 entries). The panel's own fetch/display
  limit is separately configurable (Settings → General)

## Tabs & session persistence

- Five tab kinds: "query" (editor + results), "table" (opened from the
  schema tree, results only, backed by the WHERE bar + pagination),
  "structure" (read-only columns/indexes/constraints view), and
  "function"/"sequence" (read-only definition/details views, also opened
  from the schema tree)
- Each connection has its own independent set of tabs — switching connections
  switches the whole tab strip, not just what's shown
- Cmd/Ctrl+T opens a new tab in the currently visible connection; Cmd/Ctrl+W
  closes the active one
- Reopens the previously-open tabs of the one auto-restored connection on
  launch (toggleable — Settings → General); table tabs re-run their query,
  query tabs just restore their SQL
- A tab with unsaved cell edits prompts for confirmation before you switch
  away, close it, or re-run its query
- Per-table column order and width are remembered across sessions

## Installing & updating

- Installers (macOS, Windows, Linux) are built and published to GitHub
  Releases whenever a version tag is pushed; each release also carries a
  signed update manifest for the in-app updater
- On launch, CubbyDB silently checks for a newer release; if one exists, a
  dismissible top-of-window banner offers **Update** (downloads, installs,
  and relaunches) or **Later** (checks again next launch). A failed check
  (offline, unreachable) says nothing — it's a background check the user
  didn't ask for
- **Settings → General** also shows the current version with its own
  **Check for Updates** button, for checking on demand rather than waiting
  for the next launch
- Update payloads are signed independently of OS-level code signing — a
  separate keypair verifies every release before it's installed, regardless
  of whether that release's installer is also Apple-notarized or
  Windows-code-signed

## Settings

Three top-level tabs: **General** (behavior), **Appearance** (with
**Interface** / **Table** / **Editor** sub-tabs), and **Keyboard Shortcuts**.
Every setting applies live and is persisted (no restart needed for anything in
here — it's all frontend-only).

- **General**: restore tabs on launch, starter SQL template, auto-refresh
  schema on connect, query-history display limit, CSV export delimiter,
  row-copy delimiter
- **Appearance → Interface**: theme (8 presets — 2 light: Light, Paper; 6
  dark: Dark, Midnight, Charcoal, Slate, and two lifted from popular editor
  themes, One Dark and Dracula), accent color (10 presets — Indigo, Blue,
  Cyan, Teal, Green, Amber, Orange, Red, Pink, Purple; drives buttons, active
  states, and SQL keyword highlighting), compact top bar
- **Appearance → Table**: font, font size, row height, zebra striping, cell
  borders, header-row shading (a subtle darkening so the column-header row
  stands out from the data below), wrap-vs-truncate long text, NULL display
  style
- **Appearance → Editor**: font, font size, line-wrap
- **Keyboard Shortcuts**: a read-only catalog of every shortcut CubbyDB
  supports, grouped by where it's active (General, SQL editor, Table filter,
  Results grid, Command palette, Connection screen, Saved queries panel) —
  not yet configurable, just documented

## Error handling

- Errors are never modal — always an inline, calm strip or banner
- Query-execution errors render where results would appear, with the
  message, SQLSTATE code, hint, and character position when available
- Row-mutation errors (insert/update/delete) render in their own dismissible
  banner, independent of any pending-edits state

## Design / appearance

- 8 full themes, switches instantly, persists across launches — 2 light
  (Light, the warmer Paper) and 6 dark (Dark, the cooler-black Midnight, the
  warm-graphite Charcoal, the steel-blue Slate, and two lifted from popular
  editor themes — **One Dark** and **Dracula**, matched to each theme's own
  sourced values, not approximated). Each is a complete surfaces/borders/text
  palette, not just a filter over one base theme; accent colors carry one
  tuned variant per light/dark family (not per individual theme), applied
  over whichever of the 8 is active — pick the Purple accent for the closest
  match to One Dark's or Dracula's own native keyword color. One Dark's
  background is calibrated to DataGrip/IntelliJ's own rendering (`#23272d`),
  not just the Atom source, which reads slightly lighter/bluer on screen
- Every theme's faintest text tiers (NULL cells, placeholders) stay legible —
  One Dark and Dracula initially inherited too little contrast from their
  first pass and were retuned to match the other themes' readability
- A single token-driven design system (hairline borders, 4px base unit) — see
  AGENTS.md's Design System section for exact values
