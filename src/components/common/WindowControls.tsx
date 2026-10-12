import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/** True on Windows, where the window has no native frame
 *  (`tauri.windows.conf.json`, `decorations: false`) — so the app draws its
 *  own minimize/maximize/close, the way macOS keeps its traffic lights over
 *  an overlay title bar. Linux keeps its native frame. */
export const isWindows = navigator.userAgent.includes("Windows");

/** Minimize/maximize/close for the frameless Windows window, pinned to the
 *  window's top-right corner above every screen (connection, workspace,
 *  license gate) so it can always be closed. Renders nothing elsewhere. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWindows) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      const sync = () => {
        win
          .isMaximized()
          .then((v) => {
            if (!cancelled) setMaximized(v);
          })
          .catch(() => {});
      };
      sync();
      win
        .onResized(sync)
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Not running inside a real Tauri window (e.g. a plain browser preview).
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!isWindows) return null;
  const win = () => getCurrentWindow();

  return (
    <div className="window-controls">
      <button
        className="window-controls__btn"
        onClick={() => void win().minimize()}
        aria-label="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        className="window-controls__btn"
        onClick={() => void win().toggleMaximize()}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" />
            <rect x=".5" y="2.5" width="7" height="7" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="window-controls__btn window-controls__btn--close"
        onClick={() => void win().close()}
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
