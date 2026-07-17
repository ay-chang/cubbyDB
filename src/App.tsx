import { useEffect } from "react";

import { Spinner } from "./components/common/Spinner";
import { ConnectionScreen } from "./components/connection/ConnectionScreen";
import { Workspace } from "./components/workspace/Workspace";
import { useStore } from "./state/store";

export function App() {
  const view = useStore((s) => s.view);
  const reconnecting = useStore((s) => s.reconnecting);
  const lastConnection = useStore((s) => s.lastConnection);
  const initialize = useStore((s) => s.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (reconnecting) {
    return (
      <div className="splash">
        <Spinner />
        <span>
          {lastConnection
            ? `Reconnecting to ${lastConnection.name}…`
            : "Starting CubbyDB…"}
        </span>
      </div>
    );
  }

  return view === "connection" ? <ConnectionScreen /> : <Workspace />;
}
