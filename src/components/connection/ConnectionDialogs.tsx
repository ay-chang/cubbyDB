import type { ReactNode } from "react";

import { useStore } from "../../state/store";
import { ConnectionScreen } from "./ConnectionScreen";

/**
 * The add/manage-connection and edit-live-connection overlays. Mounted once
 * at the app level (not in `TopBar`) so they open from anywhere — the top
 * bar's "+" and pill menu, Settings → Connections, or the AI panel's nudge —
 * including from the full-page connect screen, where there's no top bar.
 */
export function ConnectionDialogs() {
  const panel = useStore((s) => s.connectionPanel);
  const closePanel = useStore((s) => s.closeConnectionPanel);
  const editSessionId = useStore((s) => s.editConnectionSessionId);
  const closeEdit = useStore((s) => s.closeEditConnection);

  return (
    <>
      {panel && (
        <ConnectionOverlay
          title={panel.savedConnectionId ? "Edit saved connection" : "Add connection"}
          onClose={closePanel}
        >
          <ConnectionScreen
            embedded
            initialSavedId={panel.savedConnectionId ?? undefined}
            onConnected={closePanel}
          />
        </ConnectionOverlay>
      )}
      {editSessionId && (
        <ConnectionOverlay title="Edit connection" onClose={closeEdit}>
          <ConnectionScreen embedded editSessionId={editSessionId} onConnected={closeEdit} />
        </ConnectionOverlay>
      )}
    </>
  );
}

function ConnectionOverlay(props: { title: string; onClose: () => void; children: ReactNode }) {
  const { title, onClose, children } = props;
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="add-connection-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__head">
          <span className="settings-panel__title">{title}</span>
          <button
            className="settings-panel__close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
