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
  connection — the "+" in the top bar's connection switcher (or
  Cmd/Ctrl+Shift+N) opens a form for an *additional* database. Every open
  connection's session, tabs, and schema tree stay alive in the background;
  a row of pills in the top bar lets you jump between their workspaces
  instantly (no reconnect). Each pill has its
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
- The top-bar **Schema** button (Cmd/Ctrl+B by default) hides or restores the
  sidebar, giving wide result sets the full window when the navigator is not
  needed
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
- **Cmd/Ctrl+K workspace palette**: search and switch across common actions,
  Settings sections, live connections, open tabs, tables, columns, saved
  queries, and cubbies. Its empty All view prioritizes useful actions, open
  tabs, connections, and recently opened database objects instead of dumping
  the full schema — cubbies rank right after recent database objects, before
  everything else. Dedicated Cubbies / Tables / Columns / Scripts scopes keep
  large databases manageable. Results retain connection badges and color
  tags, fuzzy-match highlighting, and enough context to distinguish similarly
  named objects. Enter opens or runs the highlighted result, while the
  persistent footer documents arrow-key navigation, Enter, and Escape.
  Selecting a table opens its rows; selecting a column opens its table
  structure and highlights the column; selecting a cubby opens it, same as
  the Cubbies panel; cross-connection results switch connections first
- The schema filter shows the current quick-jump binding (Cmd/Ctrl+K by
  default) as a compact clickable key hint, so the cross-connection search is
  discoverable without taking space away from the schema tree

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
- Query results are **paginated**, 500 rows a page, with the same Prev/Next
  pager the table browser uses — results are no longer capped at a fixed
  number of rows. The backend appends `LIMIT`/`OFFSET` to an unbounded single
  SELECT; it is appended rather than wrapped in a subquery, so the query's own
  `ORDER BY` still decides what lands on each page. Re-running a query returns
  to the first page; a background refresh stays where you are
- A query that carries **its own `LIMIT`** is run exactly as written and shown
  whole rather than paged — the "Limit applied" badge marks that case, since
  the rest of the result isn't reachable by paging. Remove the LIMIT to page
  through everything
- Multiple tabs; drag to reorder; "+" to add, click to close.
  Cmd/Ctrl+T opens a new tab and Cmd/Ctrl+W closes the active one from
  anywhere in the workspace (both route through the same unsaved-edits
  confirmation as the tab-strip's own "+"/"×"). Cmd/Ctrl+Shift+[ and
  Cmd/Ctrl+Shift+] move to the previous/next tab and wrap at either end.
  Cmd/Ctrl+1 through Cmd/Ctrl+9 jump directly to the corresponding tab; while
  the configured modifier is held, the first nine tabs show compact shortcut
  pills inline after their titles, never covering the title or tab controls
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

## Cubbies

- A cubby is a named collection of *references* — tables, saved queries, AI
  chats, and structure/function/sequence views — for one task ("Q3 churn
  investigation"), so opening it brings everything you were using back at
  once. It stores pointers only, never copies: editing a saved query's SQL or
  a table's data is instantly reflected everywhere the cubby references it,
  and deleting a cubby never deletes what it pointed to
- Membership is non-exclusive — the same table can belong to any number of
  cubbies. Scoped to one saved connection (a cubby needs the connection
  saved first), since most of what it holds only makes sense against a
  specific database
- The **Cubby** button (top bar, next to Ask AI) opens the Cubbies panel — a
  resizable drawer (drag its left edge, same as the AI panel) listing every
  cubby for the active connection as one compact row each (name, entry
  count, last-updated, inline rename and delete), with **New** to create one
- **Clicking a row opens that cubby** — no expanding first; clicking the
  active one again closes it (unpins, without closing any tabs). The row's
  ▶ chevron is separate and non-committal: it expands the entry list in
  place so entries can be reviewed or removed without opening anything
- Opening connects to the cubby's database (reusing an already-open
  connection if there is one, otherwise connecting fresh from the saved
  record) and restores a tab for every entry — the same open/focus logic
  each entry kind already uses elsewhere (Select top 100, saved query, AI
  chat, structure/function/sequence view). The opened cubby becomes the
  **active** cubby, shown as its name on the Cubby button and marked
  "pinned" in the list, until closed or until switching to a different
  connection un-pins it
- **Close other tabs when opening a cubby** (Settings → General) chooses
  between the two ways that can go: on, the cubby opens onto a clean slate
  and its entries become the only open tabs; off (the default), its tabs are
  added alongside whatever was already open. Clearing asks once up front if
  any open tab has unsaved cell edits — answering no leaves everything as it
  was rather than opening the cubby half-way
- Cubbies are also reachable from the **Cubbies** scope in the Cmd/Ctrl+K
  palette — its own tab, and the second group shown (right after recent
  database objects) in the default All view
- **Add to cubby**, active only while a cubby is open: on a table's,
  function's, or sequence's right-click menu in the schema tree; by
  right-clicking any **tab** in the tab strip; next to a Saved Queries panel
  row (+); and on the current AI conversation once it has a saved-chat id.
  Right-clicking a never-saved query tab explains it has to be saved first
  (an unsaved tab has no stable id for a cubby entry to point at)
- The active cubby's tables are **pinned** in a collapsible group above the
  regular list in the schema tree sidebar — additive, not a replacement; the
  text filter above still searches the whole schema regardless of what's
  pinned. Rows show the bare table name (with a muted schema prefix only when
  the pinned tables span more than one schema), and a pinned row's own "×"
  (on hover) removes it from the cubby directly, without opening the Cubbies
  panel
- The AI assistant gets the active cubby's context automatically: its tables
  render in full column detail even on a large schema that would otherwise
  abbreviate everything past 30 tables, while the rest of the database stays
  fully reachable via the assistant's own schema tools

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

## AI assistant

- **Ask AI** is a schema-aware chat for writing SQL and answering questions
  about the connected database. It can inspect table structure, search the
  schema, sample rows, run read-only SQL, and explain queries; every database
  tool is compile-time limited to a dedicated read-only database capability.
  Model-generated SQL must be exactly one SELECT-family statement: a
  hardcoded allowlist rejects writes, DDL, session/transaction commands, and
  multi-statement input before PostgreSQL runs it in an always-rolled-back
  read-only transaction. Tool activity is shown beneath the answer
- Supports three independent provider routes: bring-your-own **Anthropic** and
  **OpenAI** API keys, plus the user's current **Codex CLI / ChatGPT
  subscription** login. Switching providers does not replace the others'
  credentials or model choices
- Codex subscription mode delegates sign-in, credential storage, refresh,
  model discovery, and inference to the official Codex CLI. An existing
  `codex login` is recognized automatically; when it is not signed in,
  Settings can start the official browser login. CubbyDB never reads or copies
  Codex tokens. Each turn is ephemeral, runs in an empty CubbyDB-owned
  workspace with approvals disabled and a read-only sandbox, and disables web
  search, external environments, and capability roots so the supplied
  read-only database tools are its only useful capabilities
- Available models are fetched live from the selected provider after its API
  key is saved or its Codex account is signed in. New installs default to
  Anthropic for backward compatibility. OpenAI and Codex use explicit GPT-5.6
  model IDs instead of the ambiguous `gpt-5.6` alias; both default to
  **GPT-5.6 Luna**
- OpenAI and Codex have a separate persisted reasoning-level selector. The
  choices follow the selected model's advertised capabilities, and the
  default is **medium**. Codex passes both the chosen model and effort to its
  app-server turn
- API keys stay in CubbyDB's local app-data config with `0600` permissions on
  Unix and are never returned to the frontend after saving. They are currently
  stored as plaintext, matching saved database passwords
- Chats are scoped to the saved connection and persist across restarts. An
  ad-hoc unsaved connection keeps chat history only for its current session
- A failed turn shows as a retryable strip beside the thread rather than as a
  reply. The failure is never written into the chat or sent back to the model
  as something it said, so retrying asks the original question cleanly
- **Stop** replaces Send while a turn is in flight, handing the panel back
  without waiting. The provider request itself can't be aborted, so its
  tokens are still spent — the abandoned reply is discarded when it arrives
- Each answer has **Copy**, and the most recent one also has **Regenerate**,
  which discards it and asks the same question again. Only the newest reply
  can be regenerated, since replacing an earlier one would discard everything
  said after it
- The Ask AI panel toggles with Cmd/Ctrl+J (rebindable in Settings)
- Any table in an answer has a **Download CSV** button, so asking the
  assistant to export something produces a real file rather than CSV text to
  copy by hand. When a table is offered for download the answer shows the
  data once, in that table, instead of repeating it as text
- Tables are previews, labelled with the real total ("10 of 292 rows"), so a
  large result never floods the panel. **Download CSV** re-runs the query
  behind the answer and exports every row, not just the previewed ones — so
  size is never a reason the assistant can't export something. Re-running
  goes through the same read-only, always-rolled-back path the assistant's
  own queries use. A turn that ran more than one query falls back to
  exporting the rows on screen, since which query produced the table would
  be a guess
- CSV export — from an answer's table or the results grid — opens the native
  save dialog, so the folder and filename are chosen and confirmed before
  anything is written, and a toast confirms the saved file afterwards.
  Dismissing the dialog writes nothing. Files carry a UTF-8 BOM so they open
  correctly in Excel (accented text included) and use the delimiter from
  Settings > General
- Answers render as formatted Markdown: row results come back as real tables
  (scrollable, with the values in mono), the specific figure that answers the
  question is bolded, and identifiers are set as inline code. Headings, lists,
  quotes, and links are styled to match the rest of the app. What the user
  typed is always shown verbatim
- SQL in an answer gets a syntax-highlighted code block with **Copy** and
  **Open in editor**. The same two buttons appear on each SQL step under a
  message's expanded tool trace, so any statement the assistant actually ran
  can be pulled out and worked on. **Open in editor** loads the statement
  into a new query tab and focuses it — it never runs anything; executing it
  is still an explicit action. Steps that record a table name or search term
  rather than a statement (`describe_table`, `sample_rows`, `search_schema`)
  show no buttons

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

Four top-level tabs: **General** (behavior), **Appearance** (with
**Interface** / **Table** / **Sidebar** / **Editor** sub-tabs), **AI Assistant**, and
**Keyboard Shortcuts**.
Every setting applies live and is persisted (no restart needed for anything in
here — it's all frontend-only). Open Settings from the top-bar gear or with
the fixed, platform-standard Cmd/Ctrl+, shortcut. While Settings is open,
Cmd/Ctrl+W closes the dialog rather than the database tab behind it.

- The Settings rail includes search across every preference, appearance
  control, AI option, application command, and built-in keyboard interaction.
  Results show their section path; selecting one routes to the correct section
  and Appearance sub-tab, scrolls to the exact control, and briefly highlights
  it. Arrow keys and Enter work directly from the search field, while Escape
  clears the current search

- **General**: restore tabs on launch, close other tabs when opening a cubby,
  starter SQL template, auto-refresh schema on connect, query-history display
  limit, CSV export delimiter, row-copy delimiter
- **Appearance → Interface**: theme (8 presets — 2 light: Light, Paper; 6
  dark: Dark, Midnight, Charcoal, Slate, and two lifted from popular editor
  themes, One Dark and Dracula), accent color (20 presets — Green, Indigo,
  Blue, Sky, Cyan, Teal, Emerald, Lime, Yellow, Amber, Orange, Red, Rose,
  Pink, Fuchsia, Purple, Violet, Brown, Stone, Zinc; drives buttons, active
  states, and SQL keyword highlighting, and doubles as the connection-tag
  palette), compact top bar
- **Appearance → Table**: font, font size, row height, zebra striping, cell
  borders, header-row shading (a subtle darkening so the column-header row
  stands out from the data below), wrap-vs-truncate long text, NULL display
  style
- **Appearance → Sidebar**: schema-tree row height
- **Appearance → Editor**: font, font size, line-wrap
- **AI Assistant**: provider, separate API-key settings, current Codex
  subscription status/browser sign-in, provider model, and OpenAI/Codex
  reasoning level. Saved API keys show an explicit configured state plus only
  a masked prefix/suffix identifier; the full key never returns to the UI.
  The Codex account email is blurred by default and can be revealed or hidden
  with an explicit click
- **Keyboard Shortcuts**: database and workspace commands can be rebound by
  clicking the current combination and pressing a new one. Conflicting
  workspace bindings are rejected inline; individual commands can be
  cleared/reset, and Reset all restores the defaults. Custom bindings persist
  across launches. Platform conventions such as Open Settings and native
  text/grid/dialog interactions remain fixed, but appear in the same complete
  shortcut catalog

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
