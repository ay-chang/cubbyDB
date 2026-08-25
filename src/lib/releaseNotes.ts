/**
 * "What's New" content, one entry per release — shown once via the
 * "What's New" tab (`WhatsNewPane`/`WhatsNewTrigger`) the first time a
 * build with a new entry launches.
 *
 * `WhatsNewPane` only ever renders `RELEASE_NOTES[0]` — this is a one-time
 * "here's what's new" moment after an update, not a browsable changelog
 * archive, so there's nowhere older entries are ever shown. Keep past
 * entries around below it if you want a written record in this file, or
 * don't — `git log` already is one, and nothing here depends on it.
 *
 * Maintenance: when cutting a release, add a new entry at the *top* of
 * `RELEASE_NOTES` with that version's real, user-facing changes — short,
 * plain-language sentences, not commit messages or implementation detail.
 * The version string must exactly match what `getVersion()` (Tauri)
 * resolves to for that build, i.e. `package.json` /
 * `src-tauri/tauri.conf.json`'s `version` field, or the entry will never be
 * shown. Group changes into `sections` by feature area (however many make
 * sense for that release — there's no fixed list), not by change type
 * (new/improved/fixed) — a reader wants to know "what changed in Cubbies",
 * not "what's in the New bucket vs. the Fixed bucket".
 */
export interface ReleaseNotesSection {
  heading: string;
  items: string[];
}

export interface ReleaseNotesEntry {
  version: string;
  date: string;
  sections: ReleaseNotesSection[];
}

export const RELEASE_NOTES: ReleaseNotesEntry[] = [
  {
    version: "0.1.16",
    date: "2026-08-22",
    sections: [
      {
        heading: "AI assistant",
        items: [
          "\"Ask AI\" now shows exactly which tables it's using as context — a chip for whichever table you're currently viewing, plus a \"+\" to attach more tables explicitly, regardless of which tab is open.",
          "More reliable under load: requests now retry automatically on a rate limit or a provider hiccup, Stop actually stops the in-flight request, and a long conversation no longer risks overflowing the model's context window.",
          "Schema search inside the AI now understands multi-word and abbreviated queries (\"customer orders\" can find a table named cust_ord_hdr), not just exact substrings.",
          "New opt-in AI audit log — a full record of what was sent to the model and what it did, viewable as a second tab in History. Off by default.",
        ],
      },
      {
        heading: "Schema Compare & ER diagrams",
        items: [
          "Schema Compare: diff two schemas — even across two different connections — and generate a migration script. CubbyDB never runs it for you; it's something to review and run yourself.",
          "ER diagrams: right-click a table for a visual map of it and everything directly connected to it, with draggable, collapsible table cards.",
          "Triggers and Row-Level Security policies now show up in a table's structure panel instead of being invisible.",
        ],
      },
      {
        heading: "Connections",
        items: [
          "Read-only connection mode blocks every write on a connection at the app level, independent of what the database role itself allows.",
          "SSH tunneling: connect to a database behind a bastion host, with host-key verification the first time you connect.",
        ],
      },
      {
        heading: "Fixes",
        items: [
          "Generate random UUID now works on text/varchar columns storing UUIDs as strings, not just native uuid columns.",
          "Set to NULL on a multi-cell selection now clears every selected column, not just one.",
          "Right-clicking a multi-cell range on a read-only connection no longer shows an empty menu.",
          "Viewing a function's definition could fail to load; fixed.",
          "New setting to turn off the small kind icon (table/query/function/…) shown on each tab.",
        ],
      },
    ],
  },
  {
    version: "0.1.13",
    date: "2026-08-18",
    sections: [
      {
        heading: "Selecting & editing multiple rows",
        items: [
          "Drag across cells (or Shift-click a second cell) to select a block spanning several rows — the same accent outline a single click gets, just around the whole selection.",
          "With a range selected: Remove deletes every row it touches, Cmd/Ctrl+V pastes one value into every cell it spans, and right-click offers Generate random UUIDs / Set to NULL for all of them at once instead of one cell at a time.",
          "Right-click a foreign-key or primary-key cell in a selected range to jump to related rows using every id in the selection (\"IN (...)\"), not just the one cell you clicked.",
          "The foreign-key jump menu is keyboard-navigable — arrow keys move through the table list (even while typing a filter), Enter jumps.",
          "Right-click a UUID cell — existing row, new row, or a whole selected range — for Generate random UUID.",
        ],
      },
      {
        heading: "Cubbies",
        items: [
          "Save named groups of tables, saved queries, and AI chats scoped to a connection, pin them in the schema tree, and reopen every tab in one click.",
          "Available from the schema tree, the tab bar, Cmd/Ctrl+K, and two dedicated keyboard shortcuts.",
        ],
      },
      {
        heading: "Tabs & browsing",
        items: [
          "Tabs are fixed-width with a hover tooltip for long titles, and an active tab picks up its connection's own accent color when one is set.",
          "Double-click a column's resize handle to fit it to its contents; first-load column widths now measure real rendered text instead of an approximation.",
          "The app no longer opens a blank query tab on connect — an empty state points you at the sidebar or Cmd/Ctrl+K instead.",
        ],
      },
      {
        heading: "Fixes",
        items: [
          "The \"Edit connection\" modal was rendering behind the results grid.",
          "A few icon buttons — including the tab bar itself — were missing a pointer cursor on hover.",
        ],
      },
    ],
  },
  {
    version: "0.1.12",
    date: "2026-08-14",
    sections: [
      {
        heading: "Cubbies",
        items: ["Introducing Cubbies — a first pass at named, saveable collections of database objects."],
      },
      {
        heading: "Results grid",
        items: [
          "Long cell values can now be expanded into a full, read-only view instead of just truncating.",
          "Rows referencing a foreign key are now listed alphabetically by table.",
        ],
      },
      {
        heading: "Tabs",
        items: ["The app opens to a calmer empty state instead of an unused blank query tab."],
      },
    ],
  },
];
