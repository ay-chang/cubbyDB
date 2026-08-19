import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

import type { ReleaseNotesSection } from "../../lib/releaseNotes";
import { RELEASE_NOTES } from "../../lib/releaseNotes";
import { useStore } from "../../state/store";

const LAST_SEEN_KEY = "cubbydb.whatsNew.lastSeenVersion";

// Was `true` while visually iterating on the tab's design — real behavior
// (below) is version-gated, so this must stay `false` for a shipped build.
const FORCE_SHOW_FOR_PREVIEW = false;

/**
 * No visual output of its own — checks once per launch whether the running
 * version has an unseen `RELEASE_NOTES` entry and, if so, opens (or
 * refocuses) the "What's New" tab. Lives inside `Workspace` rather than
 * `App` (unlike `UpdateBanner`, which runs regardless of connection state):
 * tabs are scoped per-connection in this app, so there's nowhere to open
 * one before a connection exists.
 *
 * Deliberately silent on a version with *no* matching entry (a patch with
 * nothing user-facing to say) and on the very first launch ever (no
 * `lastSeenVersion` recorded at all) — greeting a brand-new user with a
 * wall of past changes before they've used the app once is the opposite of
 * useful, and there's no way to tell "fresh install" apart from "existing
 * user upgrading past the point this feature was introduced" other than
 * treating both the same: record the version, stay quiet, start showing
 * notes from the *next* release either way.
 */
export function WhatsNewTrigger() {
  const openWhatsNewTab = useStore((s) => s.openWhatsNewTab);

  useEffect(() => {
    if (FORCE_SHOW_FOR_PREVIEW) {
      void openWhatsNewTab();
      return;
    }
    let cancelled = false;
    void getVersion().then((version) => {
      if (cancelled) return;
      const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
      if (lastSeen !== version) {
        if (lastSeen && RELEASE_NOTES.some((e) => e.version === version)) {
          void openWhatsNewTab();
        }
        localStorage.setItem(LAST_SEEN_KEY, version);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [openWhatsNewTab]);

  return null;
}

/** "2026-08-18" -> "August 18, 2026". Parsed at local midnight rather than
 *  handed straight to `Date` — an ISO date with no time component parses as
 *  UTC midnight, which `toLocaleDateString` in a negative-UTC-offset zone
 *  then rolls back to the *previous* day. */
function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** A version's feature-area sections, straight from `RELEASE_NOTES` — the
 *  heading *is* the category (e.g. "Cubbies", "Fixes"), authored per
 *  release rather than bucketed into a fixed new/improved/fixed taxonomy. */
function VersionSections({ sections }: { sections: ReleaseNotesSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.heading} className="structure__section">
          <div className="structure__section-title caption">{section.heading}</div>
          <ul className="whatsnew-list">
            {section.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * The "What's New" tab's content — just the latest `RELEASE_NOTES` entry,
 * not a browsable history. Deliberate: `RELEASE_NOTES` accumulates forever
 * (every release adds an entry, none get removed — see that file's own
 * maintenance note), so a "past releases" list here would eventually be
 * hundreds of entries deep. This tab is the one-time "here's what's new"
 * moment after an update, not a changelog archive.
 */
export function WhatsNewPane() {
  const latest = RELEASE_NOTES[0];
  if (!latest) return null;

  return (
    <div className="structure">
      <div className="structure__scroll">
        <div className="whatsnew__header">
          <h1 className="whatsnew__title">CubbyDB {latest.version}</h1>
          <span className="whatsnew__date">{formatDate(latest.date)}</span>
        </div>

        <VersionSections sections={latest.sections} />
      </div>
    </div>
  );
}
