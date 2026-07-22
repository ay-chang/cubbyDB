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
- Save, rename (via re-save), and delete named connections; shown as cards you
  can click to reload into the form
- Clicking a saved card loads it into the form and keeps it selected even as
  you edit fields; an "Editing X" note appears, and editing enables both
  **Update** (overwrites the selected connection) and **Save as new**
  (creates a separate connection, leaving the original untouched) — so which
  one you're about to do is always explicit, never inferred silently
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

## Schema browser

- Collapsible tree: schemas → tables/views → columns
- Filter box — matches schema, table, or column names
- Compact row-count badge per table/view (e.g. "1.2M", "88k")
- Click a table/view to browse its rows in a new tab (or focus the existing
  one if already open)
- Right-click a table for a context menu ("Select top 100")
- Expand a table in the tree to see its columns, with a primary-key badge

## SQL editor

- CodeMirror 6 with Postgres syntax highlighting (keywords, strings, numbers,
  comments)
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

## Results grid

- Any query's result set: resizable columns, drag-to-reorder columns,
  per-column sort (click a header, cycles ascending → descending → none)
- Numeric columns are auto-detected and right-aligned in monospace
- Foreign-key navigation: right-click a cell that references (or is
  referenced by) another row to jump straight to it, opening/focusing a table
  tab
- CSV export, with a configurable field delimiter
- **Find in results** (Cmd/Ctrl+F): a query box scoped to the active grid,
  matching case-insensitively against every existing-row cell. Matches are
  highlighted, the current one distinctly; Enter/Shift+Enter or the ‹ › in
  the find bar jump between them, scrolling the grid as needed. Draft/new
  rows aren't searched — they're few and already on-screen
- Font, font size, row height, zebra striping, cell borders (gridlines),
  text wrap-vs-truncate, and how NULL renders (literal text / dash / blank)
  are all configurable (Settings → Appearance → Table)

## Table browsing (no SQL required)

- Clicking a table opens a backend-generated `SELECT * ... LIMIT ... OFFSET
  ...` — the frontend never assembles this SQL itself
- A `WHERE` filter bar: type a predicate, press Enter/Apply; the backend
  rebuilds the query with it
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

## Query history

- Every query — success or failure — is logged locally with its timestamp,
  row count, elapsed time, and (on failure) the error message
- Slide-in panel; click an entry to re-run it in a new tab
- Clearable; capped on disk (~1000 entries). The panel's own fetch/display
  limit is separately configurable (Settings → General)

## Tabs & session persistence

- Three tab kinds: "query" (editor + results), "table" (opened from the
  schema tree, results only, backed by the WHERE bar + pagination), and
  "structure" (read-only columns/indexes/constraints view)
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

## Settings

Two top-level tabs: **General** (behavior) and **Appearance** (with
**Interface** / **Table** / **Editor** sub-tabs). Every setting applies live
and is persisted (no restart needed for anything in here — it's all
frontend-only).

- **General**: restore tabs on launch, starter SQL template, auto-refresh
  schema on connect, query-history display limit, CSV export delimiter,
  row-copy delimiter
- **Appearance → Interface**: light/dark theme, compact top bar
- **Appearance → Table**: font, font size, row height, zebra striping, cell
  borders, wrap-vs-truncate long text, NULL display style
- **Appearance → Editor**: font, font size, line-wrap

## Error handling

- Errors are never modal — always an inline, calm strip or banner
- Query-execution errors render where results would appear, with the
  message, SQLSTATE code, hint, and character position when available
- Row-mutation errors (insert/update/delete) render in their own dismissible
  banner, independent of any pending-edits state

## Design / appearance

- Full light/dark theme, switches instantly, persists across launches
- A single token-driven design system (indigo accent, hairline borders, 4px
  base unit) — see AGENTS.md's Design System section for exact values
