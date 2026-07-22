# CubbyDB Settings Plan

Living plan for the Settings modal: target navigation structure, what's shipped,
what's next, and a backlog of proposed options. Update this file as items ship
— flip `[ ]` to `[x]` and move the line into **Done**.

## Navigation structure (current)

```
Settings
├── General             (top-level tab — behavior settings)
└── Appearance           (top-level tab)
    ├── Interface         (sub-tab — theme, top bar)
    ├── Table             (sub-tab — results-grid display)
    └── Editor            (sub-tab — SQL editor display)
```

`General` and `Appearance` are top-level rail items. `Interface`/`Table`/`Editor`
are sub-tabs inside `Appearance`, shown as a strip at the top of its panel.
**This structure is built.**

## Status legend

- `[x]` **Done** — shipped and working
- `[ ]` under **Planned next** — decided, actively being built
- `[ ]` under **Proposed backlog** — an option on the table, not yet confirmed

## Done

**Settings shell**
- [x] Settings modal + rail (`SettingsDialog.tsx`), opened from the top bar
- [x] Two-level IA: **General**/**Appearance** top-level tabs, with
      **Interface**/**Table**/**Editor** sub-tabs inside Appearance
- [x] Settings pane enlarged (620×420 → 760×560)
- [x] Reusable `.toggle` pill switch component, used by every on/off setting

**Appearance → Interface**
- [x] **Theme**: Light/Dark toggle, persisted, applied via `data-theme` on
      `<html>` (`store.ts`, `tokens.css` dark block)
- [x] **Compact top bar**: on/off toggle that hides the Postgres-version
      subtext in the connection pill (`TopBar.tsx`)

**Appearance → Table**
- [x] **Font**: 4 options — Sans (default), Classic Code (mono), Serif,
      System — each with a live preview, applied via `--table-font`
- [x] **Font size**: exact-value dropdown (10–18px), applied via
      `--table-font-size`, with a live preview swatch. Numeric columns and the
      inline cell-edit input scale with it; the header row and row-number
      gutter stay fixed (chrome, not data)
- [x] **Row height**: exact-value dropdown (26–44px, density-labeled:
      Compact/Cozy/Comfortable/Relaxed/Spacious/Extra spacious), applied via
      the existing `--h-grid-row`, with a live preview box that grows/shrinks
- [x] **Zebra striping**: on/off toggle, applied via `--table-zebra`
- [x] **Cell borders**: on/off toggle for gridlines (row + cell dividers),
      applied via `--table-border-row`/`--table-border-cell`
- [x] **Wrap long text**: on/off toggle, applied via
      `--table-white-space`/`--table-cell-overflow`. Rows are CSS grid tracks
      with no fixed height, so a wrapped cell grows its row naturally — no
      extra layout logic needed
- [x] **NULL display**: dropdown — literal `NULL` text (default), a muted
      dash, or blank. Unlike the other Table settings this isn't a CSS
      variable: `ResultsPane.tsx` reads it directly to decide what to render.
      The hover tooltip always still says "NULL" regardless of the display
      style, since a blank/dash display makes the tooltip the only way to
      distinguish a real NULL from an empty string

**Appearance → Editor**
- [x] **Font**: same 4 stacks as the table, but the editor's own default is
      Classic Code (mono) — applied via `--editor-font` in `editorTheme.ts`
- [x] **Font size**: exact-value dropdown (10–22px), applied via
      `--editor-font-size`. The scroller's line-height is unitless (`1.7`) so
      it scales automatically with the font size instead of needing a second
      variable
- [x] **Wrap long lines**: on/off toggle. Unlike the other Editor settings
      this isn't a CSS variable — it swaps CodeMirror's `EditorView.lineWrapping`
      extension in/out (`SqlEditor.tsx`)

**General**
- [x] **Restore tabs on launch**: on/off toggle, gates `loadPersistedTabs()`
      in `initialize()`
- [x] **Starter SQL**: editable textarea for the placeholder text new query
      tabs open with (previously a fixed constant)
- [x] **Auto-refresh schema**: on/off toggle, gates the `refreshSchema()` call
      in `connectTo()`
- [x] **Query history limit**: dropdown (50/100/200/500/1000) for how many
      entries the History panel fetches/shows. This is a *display* limit
      only — it does not change the backend's on-disk retention cap (see
      "Deferred" below)
- [x] **CSV export delimiter**: comma (default)/tab/semicolon, used in
      `toCsv()`. The quote-escaping regex now also quotes fields containing
      whichever delimiter is active, not just a hardcoded comma
- [x] **Row-copy delimiter**: tab (default)/comma/semicolon, used when
      copying one or more rows to the clipboard. Kept as a *separate* setting
      from the CSV delimiter (rather than merged into one) because their
      sensible defaults genuinely differ by context — tab pastes cleanly into
      spreadsheets, comma is the standard for a `.csv` file

## Planned next

Nothing queued — pick the next item from the backlog below.

## Proposed backlog

Not yet confirmed — pick which of these to build next.

### Appearance → General (a possible 4th Appearance sub-tab)
- [ ] Accent color presets instead of fixed indigo — **deferred, bigger
      lift**: each preset needs a full derived-token set (hover/tint/
      tint-text/glow/glow-soft — 5 tokens) picked tastefully for *both* light
      and dark themes, so a handful of presets is 10+ hand-picked colors with
      real contrast/taste risk, not a mechanical swap like the settings above

### General (behavior)
- [ ] Default table-browser page size (currently fixed at 500 — frontend-only,
      should be a quick add whenever it's next)
- [ ] Default row limit for unbounded `SELECT *` — **deferred**: the limit is
      applied in Rust (`db/postgres.rs`'s `apply_default_limit`, currently the
      constant `DEFAULT_ROW_LIMIT = 100`). Making it configurable needs a new
      parameter threaded through the `run_query` command and the
      `DbSession::run_query` trait method, which means a Rust rebuild to
      verify — bigger scope than everything above, which was all frontend-only
      and hot-reloaded live

### Flagged as non-trivial (don't expect a quick add)
- [ ] Warn before running `DELETE`/`UPDATE` without a `WHERE` — needs real SQL
      parsing to detect reliably, not just a keyword search
- [ ] Per-column timestamp/timezone formatting — the driver returns every
      value as plain text (`simple_query`, no type info), so this needs a new
      type-aware layer first
