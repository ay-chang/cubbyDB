import type { ReactNode } from "react";

/**
 * The floating window-card used by the connection screen. A restrained header
 * strip (no faux traffic-light dots — the OS provides the real window controls)
 * sits above the framed body, matching the design's app-frame treatment.
 *
 * Doesn't need the same macOS traffic-light inset `TopBar` does: `.conn-screen`
 * (the outer wrapper) has 48px of top padding, well clear of the overlaid
 * traffic lights at `trafficLightPosition` (`tauri.conf.json`) — this card
 * never sits underneath them in the first place.
 */
export function AppFrame(props: {
  title: string;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div className="app-frame" style={{ maxWidth: props.maxWidth }}>
      <div className="app-frame__bar" data-tauri-drag-region>
        <span className="app-frame__title">{props.title}</span>
      </div>
      <div className="app-frame__body">{props.children}</div>
    </div>
  );
}
