/**
 * Icons for the top bar's right-edge cluster (`TopBar.tsx`).
 *
 * Drawn at the same scale and weight as the settings gear that already lives
 * there — `viewBox="0 0 24 24"` rendered at 15px, `strokeWidth: 2`,
 * `currentColor` — rather than `tabIcons.tsx`'s 16-box/1.5-weight set, which
 * is tuned for the much smaller markers inside a tab label. Keeping the two
 * scales separate is deliberate: an icon lifted from one context into the
 * other reads visibly too heavy or too faint.
 *
 * Every one of these buttons is icon-only, so its `title` is the only label
 * it has — see `TopBar.tsx`, where each also carries its keyboard shortcut.
 */

type IconProps = { className?: string };

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Cubbies — an archive box, matching the "put things away in a named
 *  container" idea the feature is built around. */
export function CubbyIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
      <path d="M10 12.5h4" />
    </Svg>
  );
}

/** Saved queries — a bookmark, the conventional "kept for later" mark. */
export function SavedIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

/** Query history — a clock. Deliberately a plain clock rather than the
 *  clock-with-a-backwards-arrow "history" glyph: at 15px the arrow turns to
 *  mush, and the two read the same anyway next to a bookmark. */
export function HistoryIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  );
}

/** Refresh — the standard circular arrow. */
export function RefreshIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3.5V9h-5.5" />
    </Svg>
  );
}

/** The momentary "Refreshed ✓" state the refresh button flashes on success —
 *  the icon-only stand-in for the text it used to swap its label to. */
export function CheckIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20 6.5 9.5 17 4 11.5" />
    </Svg>
  );
}
