import type { ReactNode } from "react";

/**
 * The floating window-card used by the connection screen. A restrained header
 * strip (no faux traffic-light dots — the OS provides the real window controls)
 * sits above the framed body, matching the design's app-frame treatment.
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
