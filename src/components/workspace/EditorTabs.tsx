import { useStore } from "../../state/store";

/** The tab strip above the editor. Active tab carries a 2px accent underline. */
export function EditorTabs() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const newTab = useStore((s) => s.newTab);

  return (
    <div className="tabs">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={"tab" + (active ? " tab--active" : "")}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab__marker mono">
              {tab.kind === "table" ? "▦" : "◆"}
            </span>
            <span className="tab__title">{tab.title}</span>
            <span
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title="Close tab"
            >
              ×
            </span>
          </div>
        );
      })}
      <button className="tab__add" onClick={() => newTab()} title="New query tab">
        +
      </button>
    </div>
  );
}
