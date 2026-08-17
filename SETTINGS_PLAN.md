# CubbyDB Settings Plan

Backlog for the Settings modal — genuinely unbuilt ideas only. **What's already
shipped lives in [FEATURES.md](FEATURES.md)'s Settings section**, which is the
current, authoritative catalog (four top-level tabs: General, Appearance —
with Interface/Table/Sidebar/Editor sub-tabs — AI Assistant, Keyboard
Shortcuts). Don't duplicate that list here; it drifted out of sync once
already (this file previously described a 3-sub-tab Appearance with no
Sidebar tab, and still listed accent-color presets as an unbuilt idea after
they'd shipped as 20 presets) — that's exactly the failure mode to avoid.

Update this file as items ship — flip `[ ]` to `[x]`, move the line into a
one-line pointer at FEATURES.md, and delete it from here.

## Proposed backlog

Not yet confirmed — pick which of these to build next.

- [ ] Default table-browser page size (currently fixed at 500 — frontend-only,
      should be a quick add whenever it's next)
- [ ] Default row limit for unbounded `SELECT *` — **deferred**: the limit is
      applied in Rust (`db/postgres.rs`'s `apply_default_limit`, currently the
      constant `DEFAULT_ROW_LIMIT = 100`). Making it configurable needs a new
      parameter threaded through the `run_query` command and the
      `DbSession::run_query` trait method, which means a Rust rebuild to
      verify — bigger scope than a frontend-only, hot-reloaded setting

## Flagged as non-trivial (don't expect a quick add)

- [ ] Warn before running `DELETE`/`UPDATE` without a `WHERE` — needs real SQL
      parsing to detect reliably, not just a keyword search
- [ ] Per-column timestamp/timezone formatting — the driver returns every
      value as plain text (`simple_query`, no type info), so this needs a new
      type-aware layer first
