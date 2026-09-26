import { useEffect } from "react";

import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { DeleteImpactDialog } from "./components/common/DeleteImpactDialog";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { SettingsDialog } from "./components/common/SettingsDialog";
import { Spinner } from "./components/common/Spinner";
import { ConnectionScreen } from "./components/connection/ConnectionScreen";
import { Workspace } from "./components/workspace/Workspace";
import { matchesKeybinding, useKeybindingStore } from "./lib/keybindings";
import { useStore } from "./state/store";

export function App() {
  const view = useStore((s) => s.view);
  const reconnecting = useStore((s) => s.reconnecting);
  const openConnections = useStore((s) => s.openConnections);
  const initialize = useStore((s) => s.initialize);
  const openSettings = useStore((s) => s.openSettings);
  const settingsBinding = useKeybindingStore(
    (s) => s.bindings["workspace.openSettings"],
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || reconnecting) return;
      if (!matchesKeybinding(event, settingsBinding)) return;
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSettings, reconnecting, settingsBinding]);

  if (reconnecting) {
    return (
      <div className="splash">
        <Spinner />
        <span>
          {openConnections.length > 0
            ? `Reconnecting to ${openConnections.map((c) => c.name).join(", ")}…`
            : "Starting CubbyDB…"}
        </span>
      </div>
    );
  }

  return (
    <>
      {view === "connection" ? (
        <ConnectionScreen />
      ) : (
        <ErrorBoundary>
          <Workspace />
        </ErrorBoundary>
      )}
      <ConfirmDialog />
      <DeleteImpactDialog />
      <SettingsDialog />
    </>
  );
}
