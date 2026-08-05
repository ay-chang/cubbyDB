import { useEffect, useMemo, useRef, useState } from "react";

import { formatCount } from "../../lib/format";
import type { FuzzyMatch } from "../../lib/fuzzyMatch";
import { formatBinding, useKeybindingStore } from "../../lib/keybindings";
import { accentPaletteFor, THEME_MODE, useStore } from "../../state/store";
import {
  buildPaletteGroups,
  PALETTE_SCOPES,
  tabIcon,
  type PaletteItem,
  type PaletteScope,
} from "./commandPaletteItems";

function singleLine(text: string, limit: number): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

function formatHistoryTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render `text` with the characters at `indices` wrapped in <mark>. */
function highlight(text: string, match: FuzzyMatch | null): React.ReactNode {
  if (!match || match.indices.length === 0) return text;
  const indices = new Set(match.indices);
  const parts: React.ReactNode[] = [];
  let buffer = "";
  let matching = false;
  let key = 0;
  for (let index = 0; index < text.length; index += 1) {
    const nextMatching = indices.has(index);
    if (nextMatching !== matching && buffer) {
      parts.push(matching ? <mark key={key++}>{buffer}</mark> : buffer);
      buffer = "";
    }
    buffer += text[index];
    matching = nextMatching;
  }
  if (buffer) parts.push(matching ? <mark key={key++}>{buffer}</mark> : buffer);
  return parts;
}

function itemIcon(item: PaletteItem): string {
  switch (item.kind) {
    case "action":
      switch (item.action) {
        case "new-query":
          return "+";
        case "refresh":
          return "↻";
        case "ask-ai":
          return "◇";
        case "saved-queries":
          return "▤";
        case "query-history":
          return "◷";
      }
    case "setting":
      return "⚙";
    case "connection":
      return "●";
    case "tab":
      return tabIcon(item.tab.kind);
    case "table":
      return item.tableKind === "view" ? "▨" : "▦";
    case "column":
      return "·";
    case "script":
      return "▤";
    case "history":
      return item.entry.success ? "✓" : "×";
  }
}

function itemLabel(item: PaletteItem): React.ReactNode {
  const titleMatch = item.match.candidate === 0 ? item.match : null;
  switch (item.kind) {
    case "action":
    case "setting":
      return highlight(item.label, titleMatch);
    case "connection":
      return highlight(item.connectionName, titleMatch);
    case "tab":
      return highlight(item.tab.title, titleMatch);
    case "table":
      return (
        <>
          <span className="cmdk-item__path">{item.schema}.</span>
          {highlight(item.table, titleMatch)}
        </>
      );
    case "column":
      return (
        <>
          <span className="cmdk-item__path">
            {item.schema}.{item.table}.
          </span>
          {highlight(item.column, titleMatch)}
        </>
      );
    case "script":
      return highlight(item.query.name, titleMatch);
    case "history":
      // Search uses the complete SQL, while the row normalizes whitespace and
      // truncates it; raw fuzzy-match indices would point at the wrong glyphs.
      return singleLine(item.entry.sql, 92);
  }
}

function itemMeta(item: PaletteItem): string {
  switch (item.kind) {
    case "action":
    case "setting":
      return item.description;
    case "connection":
      return [item.active ? "Current" : null, item.database, item.host]
        .filter(Boolean)
        .join(" · ");
    case "tab":
      return item.tab.running
        ? "Running"
        : item.tab.error
          ? "Error"
          : item.active
            ? "Current tab"
            : item.tab.kind;
    case "table":
      return formatCount(item.estimatedRows);
    case "column":
      return item.dataType;
    case "script":
      return singleLine(item.query.sql, 60);
    case "history":
      return `${item.entry.success ? "Completed" : "Failed"} · ${formatHistoryTime(item.entry.executedAt)}`;
  }
}

function emptyMessage(scope: PaletteScope, hasQuery: boolean): string {
  if (hasQuery) return "No matches.";
  switch (scope) {
    case "columns":
      return "Type to search columns.";
    case "scripts":
      return "No saved scripts yet.";
    case "history":
      return "No query history yet.";
    case "tables":
      return "No tables or views.";
    case "all":
      return "No workspace items.";
  }
}

/**
 * Cmd/Ctrl+K is CubbyDB's workspace switcher. It keeps the database-specific
 * scopes that make very large schemas manageable, while All combines common
 * actions, open tabs, live connections, recent relations, saved queries, and
 * query history. Results retain the connection colors used elsewhere in the
 * workspace so staging and production remain visually distinct.
 */
export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const close = useStore((s) => s.closeCommandPalette);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const recentObjects = useStore((s) => s.recentDatabaseObjects);
  const savedQueries = useStore((s) => s.savedQueries);
  const history = useStore((s) => s.history);
  const theme = useStore((s) => s.theme);
  const switchConnection = useStore((s) => s.switchConnection);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const newTab = useStore((s) => s.newTab);
  const refreshActive = useStore((s) => s.refreshActive);
  const openSelectTop = useStore((s) => s.openSelectTop);
  const jumpToColumn = useStore((s) => s.jumpToColumn);
  const openSavedQuery = useStore((s) => s.openSavedQuery);
  const rerunFromHistory = useStore((s) => s.rerunFromHistory);
  const refreshHistory = useStore((s) => s.refreshHistory);
  const loadSavedQueries = useStore((s) => s.loadSavedQueries);
  const historyOpen = useStore((s) => s.historyOpen);
  const savedQueriesOpen = useStore((s) => s.savedQueriesOpen);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);
  const toggleHistory = useStore((s) => s.toggleHistory);
  const toggleSavedQueries = useStore((s) => s.toggleSavedQueries);
  const toggleAiPanel = useStore((s) => s.toggleAiPanel);
  const openSettings = useStore((s) => s.openSettings);
  const bindings = useKeybindingStore((s) => s.bindings);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>("all");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mouseArmedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setSelected(0);
    mouseArmedRef.current = false;
    void refreshHistory();
    void loadSavedQueries();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [loadSavedQueries, open, refreshHistory]);

  const slots = useMemo(() => Object.values(connections), [connections]);
  const groups = useMemo(
    () =>
      buildPaletteGroups({
        scope,
        query,
        slots,
        activeConnectionId,
        savedQueries,
        history,
        recentObjects,
      }),
    [activeConnectionId, history, query, recentObjects, savedQueries, scope, slots],
  );
  const results = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const showConnectionBadge = slots.length > 1;

  useEffect(() => {
    setSelected(0);
    mouseArmedRef.current = false;
  }, [query, scope]);

  useEffect(() => {
    if (selected >= results.length) setSelected(Math.max(0, results.length - 1));
  }, [results.length, selected]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const cycleScope = (delta: number) => {
    setScope((current) => {
      const index = PALETTE_SCOPES.findIndex((candidate) => candidate.id === current);
      return PALETTE_SCOPES[(index + delta + PALETTE_SCOPES.length) % PALETTE_SCOPES.length].id;
    });
  };

  const moveSelection = (delta: number) => {
    if (results.length === 0) return;
    setSelected((current) => (current + delta + results.length) % results.length);
  };

  const activate = (item: PaletteItem) => {
    close();
    switch (item.kind) {
      case "connection":
        switchConnection(item.sessionId);
        return;
      case "tab":
        if (item.sessionId !== activeConnectionId) switchConnection(item.sessionId);
        setActiveTab(item.tab.id);
        return;
      case "table":
        if (item.sessionId !== activeConnectionId) switchConnection(item.sessionId);
        void openSelectTop(item.schema, item.table);
        return;
      case "column":
        if (item.sessionId !== activeConnectionId) switchConnection(item.sessionId);
        void jumpToColumn(item.schema, item.table, item.column);
        return;
      case "script":
        void openSavedQuery(item.query);
        return;
      case "history":
        rerunFromHistory(item.entry.sql);
        return;
      case "setting":
        openSettings(item.section);
        return;
      case "action":
        switch (item.action) {
          case "new-query":
            void newTab();
            return;
          case "refresh":
            void refreshActive();
            return;
          case "ask-ai":
            if (!aiPanelOpen) toggleAiPanel();
            return;
          case "saved-queries":
            if (!savedQueriesOpen) toggleSavedQueries();
            return;
          case "query-history":
            if (!historyOpen) toggleHistory();
            return;
        }
    }
  };

  if (!open) return null;

  let resultIndex = 0;
  const hasQuery = query.trim().length > 0;
  const activeScope = PALETTE_SCOPES.find((candidate) => candidate.id === scope)!;

  return (
    <div className="cmdk-overlay" onClick={close}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search CubbyDB"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={activeScope.placeholder}
          aria-controls="command-palette-results"
          aria-activedescendant={results[selected] ? `palette-${results[selected].id}` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              event.stopPropagation();
              cycleScope(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const item = results[selected];
              if (item) activate(item);
            }
          }}
        />

        <div className="cmdk-scopes" role="tablist" aria-label="Search scope">
          {PALETTE_SCOPES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === scope}
              className={
                "cmdk-scope" +
                (candidate.id === scope ? " cmdk-scope--active" : "")
              }
              onClick={() => {
                setScope(candidate.id);
                inputRef.current?.focus();
              }}
            >
              {candidate.label}
            </button>
          ))}
          <span className="cmdk-scopes__hint mono">⇥ / ⇧⇥</span>
        </div>

        <div
          id="command-palette-results"
          ref={listRef}
          className="cmdk-list"
          role="listbox"
          onMouseMove={() => {
            mouseArmedRef.current = true;
          }}
        >
          {results.length === 0 ? (
            <div className="cmdk-empty">{emptyMessage(scope, hasQuery)}</div>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="cmdk-group" role="group" aria-label={group.label}>
                <div className="cmdk-group__label">{group.label}</div>
                {group.items.map((item) => {
                  const index = resultIndex++;
                  const connectionItem =
                    item.kind === "table" ||
                    item.kind === "column" ||
                    item.kind === "tab" ||
                    item.kind === "connection"
                      ? item
                      : null;
                  const connectionColor = connectionItem
                    ? (connections[connectionItem.sessionId]?.color ?? null)
                    : null;
                  const connectionPalette = connectionColor
                    ? accentPaletteFor(connectionColor, THEME_MODE[theme])
                    : null;
                  const connectionStyle = connectionPalette
                    ? ({ "--conn-color-tint": connectionPalette.accentTint } as React.CSSProperties)
                    : undefined;
                  const keybindingId =
                    item.kind === "action" || item.kind === "setting"
                      ? item.keybindingId
                      : undefined;
                  const binding = keybindingId ? bindings[keybindingId] : null;
                  const connectionName =
                    item.kind === "table" || item.kind === "column" || item.kind === "tab"
                      ? item.connectionName
                      : item.kind === "history"
                        ? item.entry.connectionName
                        : null;
                  return (
                    <div
                      id={`palette-${item.id}`}
                      key={item.id}
                      role="option"
                      aria-selected={index === selected}
                      data-palette-index={index}
                      className={
                        "cmdk-item" +
                        (index === selected ? " cmdk-item--active" : "") +
                        (connectionPalette ? " cmdk-item--conn-fill" : "")
                      }
                      style={connectionStyle}
                      onMouseEnter={() => {
                        if (mouseArmedRef.current) setSelected(index);
                      }}
                      onClick={() => activate(item)}
                    >
                      <span className="cmdk-item__icon" aria-hidden>
                        {itemIcon(item)}
                      </span>
                      {connectionName && showConnectionBadge && (
                        <span className="cmdk-item__conn">{connectionName}</span>
                      )}
                      <span className="cmdk-item__label">{itemLabel(item)}</span>
                      <span
                        className={
                          "cmdk-item__meta mono" +
                          (item.kind === "script" || item.kind === "history" ||
                          item.kind === "action" || item.kind === "setting"
                            ? " cmdk-item__meta--wide"
                            : "")
                        }
                      >
                        {itemMeta(item)}
                      </span>
                      {binding && (
                        <kbd className="cmdk-item__shortcut mono">{formatBinding(binding)}</kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-footer" aria-hidden>
          <span className="cmdk-footer__hint">
            <kbd>↑</kbd><kbd>↓</kbd><span>Navigate</span>
          </span>
          <span className="cmdk-footer__hint">
            <kbd>↵</kbd><span>Select</span>
          </span>
          <span className="cmdk-footer__hint">
            <kbd>Esc</kbd><span>Close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
