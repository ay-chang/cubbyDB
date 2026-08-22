/**
 * Hand-drawn SVG markers shared by the editor tab strip (`EditorTabs.tsx`)
 * and the schema tree (`SchemaTree.tsx`), so a table looks like the same
 * thing in both places. Drawn as SVG rather than left as Unicode block/star/
 * diamond characters (▦ ▤ ✦ ◆): those symbol codepoints are exactly the
 * class of glyph most prone to landing outside a font's own metrics — a
 * different fallback font can substitute in per-character, each with its own
 * ascent/descent, so even a perfectly flex-centered marker box can end up
 * visibly off against adjacent text. `viewBox="0 0 16 16"` at 12x12 roughly
 * matches those previous glyphs' visual weight at the tab strip's font size.
 *
 * Each icon takes the caller's `className` (defaulting to `tab__marker`) so
 * it picks up `currentColor` from whichever context renders it — the tab
 * strip's own tint, or the schema tree row's selected/hover state.
 */

type IconProps = { className?: string };

export function TableTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="1.5" y1="6.5" x2="14.5" y2="6.5" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="13.5" />
    </svg>
  );
}

/** Two horizontal dividers only (no vertical) — reads as a row/column
 *  listing rather than `TableTabIcon`'s grid, so the two stay visually
 *  distinct at a glance despite sharing the same outer square. */
export function StructureTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="1.5" y1="6" x2="14.5" y2="6" />
      <line x1="1.5" y1="9.5" x2="14.5" y2="9.5" />
    </svg>
  );
}

export function WhatsNewTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}

/** Two small offset rectangles with a short connecting line — reads as
 *  "comparing two things" without relying on a Unicode glyph like `⇄`,
 *  which has the same cross-font metric-drift problem the other hand-drawn
 *  icons above already avoid. */
export function SchemaCompareTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1" y="3" width="6" height="10" rx="1" />
      <rect x="9" y="3" width="6" height="10" rx="1" />
      <line x1="7.5" y1="8" x2="8.5" y2="8" />
    </svg>
  );
}

/** Three small connected nodes — reads as "a diagram/graph of related
 *  things", distinct from `SchemaCompareTabIcon`'s two-boxes-one-line
 *  shape, same hand-drawn-SVG convention as every other tab icon here. */
export function ErdTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="4" x2="12" y2="4" />
      <line x1="4" y1="4" x2="4" y2="12" />
      <line x1="4" y1="12" x2="12" y2="12" />
      <rect x="2" y="2" width="4" height="4" rx="1" />
      <rect x="10" y="2" width="4" height="4" rx="1" />
      <rect x="2" y="10" width="4" height="4" rx="1" />
    </svg>
  );
}

/** A plain query tab's marker — the fallback case for any `tab.kind` not
 *  otherwise handled above. Filled, to match the previous "◆" glyph's own
 *  weight (solid, not outlined, unlike the two grid icons above it). */
export function QueryTabIcon({ className = "tab__marker" }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" />
    </svg>
  );
}
