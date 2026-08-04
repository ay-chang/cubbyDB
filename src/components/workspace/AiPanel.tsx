import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  useActiveAiChatId,
  useActiveAiChats,
  useActiveAiChatsLoading,
  useActiveAiMessages,
  useActiveAiSending,
  useActiveConnectionCanSaveChats,
  useStore,
} from "../../state/store";
import type { AiChatSummary } from "../../types";

/** Cap on how tall the chat input grows before it starts scrolling instead —
 *  about 8-9 lines at the input's font size, VSCode-editor style. */
const AI_INPUT_MAX_HEIGHT = 160;

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Slide-in AI chat panel, scoped to the active connection (its own thread,
 *  answered using its own schema) — same drawer treatment as History/Saved
 *  Queries. Also holds that connection's saved-chat list (History view) when
 *  it has a stable id to save chats against (see `useActiveConnectionCanSaveChats`). */
export function AiPanel() {
  const messages = useActiveAiMessages();
  const sending = useActiveAiSending();
  const chatId = useActiveAiChatId();
  const chats = useActiveAiChats();
  const chatsLoading = useActiveAiChatsLoading();
  const canSaveChats = useActiveConnectionCanSaveChats();
  const historyView = useStore((s) => s.aiHistoryView);
  const aiConfig = useStore((s) => s.aiConfig);
  const sendAiMessage = useStore((s) => s.sendAiMessage);
  const toggleAiPanel = useStore((s) => s.toggleAiPanel);
  const toggleAiHistoryView = useStore((s) => s.toggleAiHistoryView);
  const newAiChat = useStore((s) => s.newAiChat);
  const openAiChat = useStore((s) => s.openAiChat);
  const renameAiChat = useStore((s) => s.renameAiChat);
  const deleteAiChat = useStore((s) => s.deleteAiChat);
  const openSettings = useStore((s) => s.openSettings);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const openEditConnection = useStore((s) => s.openEditConnection);

  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    if (!historyView) requestAnimationFrame(() => inputRef.current?.focus());
  }, [historyView]);

  // Auto-grow with content, VSCode-style — reset to measure the content's
  // true height, then clamp so long drafts scroll inside the box instead of
  // pushing it past AI_INPUT_MAX_HEIGHT. `useLayoutEffect` (not `useEffect`)
  // so the resize happens before the browser paints — otherwise the box
  // would flash at its stale size for a frame on every keystroke.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // `box-sizing: border-box` means `height` sets the *border*-box size,
    // but `scrollHeight` only measures content + padding, excluding the
    // border. Setting height straight to scrollHeight therefore comes up
    // short by the border's width — just enough for the content to overflow
    // its own box and trigger a scrollbar well before AI_INPUT_MAX_HEIGHT.
    const border =
      el.clientHeight > 0 ? el.offsetHeight - el.clientHeight : 0;
    el.style.height = `${Math.min(el.scrollHeight + border, AI_INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  const hasKey = aiConfig ? aiConfig.anthropicKeySet : true;

  const send = () => {
    const text = draft.trim();
    if (!text || sending || !hasKey) return;
    setDraft("");
    void sendAiMessage(text);
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel__head">
        <span className="caption">Ask AI</span>
        <div className="ai-panel__head-actions">
          <button
            className={"ai-panel__btn" + (historyView ? " ai-panel__btn--active" : "")}
            onClick={toggleAiHistoryView}
            title="Past chats"
          >
            History
          </button>
          <button className="ai-panel__btn" onClick={newAiChat} title="New chat">
            New
          </button>
          <button className="ai-panel__close" onClick={toggleAiPanel} title="Close">
            ×
          </button>
        </div>
      </div>

      {historyView ? (
        canSaveChats ? (
          <ChatHistoryList
            chats={chats}
            loading={chatsLoading}
            activeChatId={chatId}
            onOpen={(id) => void openAiChat(id)}
            onRename={(id, title) => void renameAiChat(id, title)}
            onDelete={(id) => void deleteAiChat(id)}
          />
        ) : (
          <div className="ai-panel__list">
            <p className="ai-panel__empty">
              This connection isn't saved, so there's no stable place to keep its chat history —
              chats here stay in-memory only, for this session.{" "}
              {activeConnectionId && (
                <>
                  <span
                    className="ai-panel__settings-link"
                    onClick={() => openEditConnection(activeConnectionId)}
                  >
                    Save this connection
                  </span>{" "}
                  to keep history across restarts.{" "}
                </>
              )}
              <span className="ai-panel__settings-link" onClick={toggleAiHistoryView}>
                Back to chat
              </span>
            </p>
          </div>
        )
      ) : (
        <>
          <div className="ai-panel__list" ref={listRef}>
            {messages.length === 0 && hasKey && (
              <p className="ai-panel__empty">
                Ask about writing SQL, or ask a question about this database — "how many rows are
                in recipes?", "what tables reference this one?".
              </p>
            )}
            {aiConfig && !hasKey && (
              <p className="ai-panel__empty">
                Add an Anthropic API key to use the AI assistant.{" "}
                <span
                  className="ai-panel__settings-link"
                  onClick={() => openSettings("aiAssistant")}
                >
                  Open Settings
                </span>
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={"ai-msg" + (m.role === "user" ? " ai-msg--user" : " ai-msg--assistant")}
              >
                <div className="ai-msg__content">{m.content}</div>
                {m.trace && m.trace.length > 0 && (
                  <details className="ai-trace">
                    <summary>
                      {m.trace.length} {m.trace.length === 1 ? "step" : "steps"}
                    </summary>
                    {m.trace.map((t, j) => (
                      <div key={j} className="ai-trace__item">
                        <span className="ai-trace__tool mono">{t.tool}</span>
                        {t.detail && <code className="ai-trace__sql">{t.detail}</code>}
                        <span className="ai-trace__meta">
                          {t.error
                            ? t.error
                            : t.rowCount !== null
                              ? `${t.rowCount} rows`
                              : "ok"}
                        </span>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
            {sending && (
              <div className="ai-msg ai-msg--assistant ai-msg--pending">
                Thinking…
              </div>
            )}
          </div>
          <div className="ai-input-row">
            <textarea
              ref={inputRef}
              className="ai-input"
              rows={1}
              placeholder={hasKey ? "Ask a question…" : "Add an API key in Settings to start"}
              value={draft}
              disabled={!hasKey}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              className="btn btn--primary ai-input-row__send"
              onClick={send}
              disabled={!hasKey || sending || !draft.trim()}
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The History view's chat list — click to open, inline rename, delete.
 *  Structurally the same as `SavedQueriesPanel`'s item list. */
function ChatHistoryList({
  chats,
  loading,
  activeChatId,
  onOpen,
  onRename,
  onDelete,
}: {
  chats: AiChatSummary[];
  loading: boolean;
  activeChatId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (chat: AiChatSummary) => {
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  };
  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (renamingId && trimmed) onRename(renamingId, trimmed);
    setRenamingId(null);
  };

  return (
    <div className="ai-panel__list ai-panel__history-list">
      {!loading && chats.length === 0 && (
        <p className="ai-panel__empty">No saved chats yet — send a message to start one.</p>
      )}
      {chats.map((chat) => (
        <div
          key={chat.id}
          className={
            "ai-chat-item" + (chat.id === activeChatId ? " ai-chat-item--active" : "")
          }
        >
          <div
            className="ai-chat-item__main"
            onClick={() => onOpen(chat.id)}
            title="Open this chat"
          >
            {renamingId === chat.id ? (
              <input
                className="ai-chat-item__rename-input"
                value={renameValue}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
              />
            ) : (
              <>
                <span className="ai-chat-item__title">{chat.title}</span>
                <span className="ai-chat-item__time mono">{formatTime(chat.updatedAt)}</span>
              </>
            )}
          </div>
          <div className="ai-chat-item__actions">
            <span
              className="ai-chat-item__rename"
              onClick={(e) => {
                e.stopPropagation();
                startRename(chat);
              }}
              title="Rename"
            >
              ✎
            </span>
            <span
              className="ai-chat-item__delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(chat.id);
              }}
              title="Delete"
            >
              ×
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
