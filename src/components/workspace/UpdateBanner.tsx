import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { installUpdate } from "../../lib/appUpdate";

/**
 * Slim top-of-workspace strip, styled after `PendingEditsBar`'s "calm,
 * inline, never modal" bar but in the success palette rather than amber —
 * this is good news, not a warning. Checks once, silently, on launch; a
 * failed check (offline, GitHub unreachable) says nothing, since the user
 * never asked for this and a background check shouldn't greet them with an
 * error for something incidental. Dismissing just hides it for the rest of
 * this session — it'll check again next launch.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    check()
      .then((result) => {
        // `check()` resolves to `null` when there's no update — `Update`'s
        // own `available` field is deprecated in favor of this null check.
        if (!cancelled && result) setUpdate(result);
      })
      .catch(() => {
        // Silent — see doc comment above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed) return null;

  const install = () => {
    setInstalling(true);
    setError(null);
    installUpdate(update).catch((e) => {
      setInstalling(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="update-banner">
      <span className="update-banner__dot" />
      <span className="update-banner__message">
        {error
          ? `Update failed: ${error}`
          : installing
            ? `Downloading CubbyDB ${update.version}…`
            : `CubbyDB ${update.version} is available — you're on ${update.currentVersion}.`}
      </span>
      {!installing && (
        <div className="update-banner__actions">
          <button className="update-banner__later" onClick={() => setDismissed(true)}>
            Later
          </button>
          <button className="update-banner__install" onClick={install}>
            Update
          </button>
        </div>
      )}
    </div>
  );
}
