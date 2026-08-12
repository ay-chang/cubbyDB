import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  useActiveAiChatId,
  useActiveAiChats,
  useActiveAiChatsLoading,
  useActiveAiMessages,
  useActiveAiError,
  useActiveAiSending,
  useActiveConnectionCanSaveChats,
  useStore,
} from "../../state/store";
import { copyToClipboard } from "../../api/backend";
import type { AiChatSummary, AiMessage } from "../../types";
import { Markdown } from "./Markdown";
import { highlightSql, SnippetActions } from "./sqlSnippet";

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
  const aiError = useActiveAiError();
  const chatId = useActiveAiChatId();
  const chats = useActiveAiChats();
  const chatsLoading = useActiveAiChatsLoading();
  const canSaveChats = useActiveConnectionCanSaveChats();
  const historyView = useStore((s) => s.aiHistoryView);
  const aiConfig = useStore((s) => s.aiConfig);
  const sendAiMessage = useStore((s) => s.sendAiMessage);
  const retryAiMessage = useStore((s) => s.retryAiMessage);
  const regenerateAiMessage = useStore((s) => s.regenerateAiMessage);
  const stopAiMessage = useStore((s) => s.stopAiMessage);
  const toggleAiPanel = useStore((s) => s.toggleAiPanel);
  const toggleAiHistoryView = useStore((s) => s.toggleAiHistoryView);
  const newAiChat = useStore((s) => s.newAiChat);
  const openAiChat = useStore((s) => s.openAiChat);
  const renameAiChat = useStore((s) => s.renameAiChat);
  const deleteAiChat = useStore((s) => s.deleteAiChat);
  const openSettings = useStore((s) => s.openSettings);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const sessionId = useStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.sessionId ?? null : null,
  );
  const openEditConnection = useStore((s) => s.openEditConnection);

  const [draft, setDraft] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
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

  const providerName = aiConfig?.provider === "openai"
    ? "OpenAI"
    : aiConfig?.provider === "codex"
      ? "Codex"
      : aiConfig?.provider === "claudeCode"
        ? "Claude Code"
        : "Anthropic";
  const hasKey = aiConfig
    ? aiConfig.provider === "codex"
      ? aiConfig.codexAuthenticated
      : aiConfig.provider === "claudeCode"
        ? aiConfig.claudeCodeAuthenticated
        : aiConfig.provider === "openai"
          ? aiConfig.openaiKeySet
          : aiConfig.anthropicKeySet
    : true;

  const send = () => {
    const text = draft.trim();
    if (!text || sending || !hasKey) return;
    setDraft("");
    void sendAiMessage(text);
  };

  const copyMessage = (content: string, index: number) => {
    void copyToClipboard(content).then(() => {
      setCopiedIndex(index);
      window.setTimeout(
        () => setCopiedIndex((current) => (current === index ? null : current)),
        1200,
      );
    });
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
                {aiConfig.provider === "codex"
                  ? "Sign in with ChatGPT to use your Codex subscription. "
                  : `Add an ${providerName} API key to use the AI assistant. `}
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
                {m.role === "user" ? (
                  <div className="ai-msg__content">{m.content}</div>
                ) : (
                  <Markdown content={m.content} source={exportSourceFor(m, sessionId)} />
                )}
                {m.trace && m.trace.length > 0 && (
                  <details className="ai-trace">
                    <summary>
                      {m.trace.length} {m.trace.length === 1 ? "step" : "steps"}
                    </summary>
                    {m.trace.map((t, j) => {
                      // Only these two record an actual statement in `detail`;
                      // the rest carry a table name or a search term, which
                      // would open a query tab that doesn't parse.
                      const isSql = t.tool === "run_sql" || t.tool === "explain_query";
                      return (
                        <div key={j} className="ai-trace__item">
                          <div className="ai-trace__item-head">
                            <span className="ai-trace__tool mono">{t.tool}</span>
                            {isSql && t.detail && (
                              <SnippetActions text={t.detail} openAsSql tabTitle="ai-step.sql" />
                            )}
                          </div>
                          {t.detail && (
                            <code className="ai-trace__sql">
                              {isSql ? highlightSql(t.detail) : t.detail}
                            </code>
                          )}
                          {t.error && <span className="ai-trace__error">{t.error}</span>}
                        </div>
                      );
                    })}
                  </details>
                )}
                {m.role === "assistant" && (
                  <div className="ai-msg__actions">
                    <button
                      className="ai-msg-action"
                      onClick={() => copyMessage(m.content, i)}
                      title={copiedIndex === i ? "Copied" : "Copy this answer"}
                      aria-label="Copy this answer"
                    >
                      {copiedIndex === i ? <CheckIcon /> : <CopyIcon />}
                    </button>
                    {/* Only the newest reply — regenerating an earlier one
                        would silently discard everything said after it. */}
                    {i === messages.length - 1 && !sending && (
                      <button
                        className="ai-msg-action"
                        onClick={() => void regenerateAiMessage()}
                        title="Discard this answer and ask again"
                        aria-label="Regenerate this answer"
                      >
                        <RegenerateIcon />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {sending && <ThinkingIndicator />}
            {aiError && (
              <div className="ai-error" role="alert">
                <span className="ai-error__msg">{aiError}</span>
                <button className="ai-error__retry" onClick={() => void retryAiMessage()}>
                  Retry
                </button>
              </div>
            )}
          </div>
          <div className="ai-input-row">
            <div className="ai-input-box">
              <textarea
                ref={inputRef}
                className="ai-input"
                rows={1}
                placeholder={hasKey ? "Ask a question…" : "Configure AI in Settings to start"}
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
              {sending ? (
                <button
                  className="ai-input-box__action ai-input-box__action--stop"
                  onClick={stopAiMessage}
                  title="Stop waiting for this reply"
                  aria-label="Stop"
                >
                  <span className="ai-input-row__stop-icon" aria-hidden />
                </button>
              ) : (
                <button
                  className="ai-input-box__action ai-input-box__action--send"
                  onClick={send}
                  disabled={!hasKey || !draft.trim()}
                  title="Send (Enter)"
                  aria-label="Send"
                >
                  <EnterIcon />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The statement to re-run when this reply's table is exported, so the
 * download carries every row rather than just the previewed ones.
 *
 * Only when the turn ran exactly one query: with several, there's no reliable
 * way to tell which one produced the table, and exporting the wrong result
 * silently would be worse than exporting the rows on screen.
 */
function exportSourceFor(
  message: AiMessage,
  sessionId: string | null,
): { sessionId: string; sql: string; rowCount: number | null } | undefined {
  if (!sessionId) return undefined;
  const queries = (message.trace ?? []).filter((t) => t.tool === "run_sql" && !t.error);
  if (queries.length !== 1) return undefined;
  return { sessionId, sql: queries[0].detail, rowCount: queries[0].rowCount };
}

/** Return-key glyph for the composer's send action — an inline icon rather
 *  than a labeled button, since Enter already sends. */
function EnterIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 5v6a2 2 0 0 1-2 2H6" />
      <path d="M9 10l-3 3 3 3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

/** Shown while a turn is in flight, in place of the old "Thinking…" bubble.
 *  Deliberately unbubbled — nothing has been said yet, so it reads as status
 *  rather than as a message. The label is two stacked copies of the same
 *  text: a plain, always-visible base underneath, and a second copy on top
 *  clipped to a moving gradient (see `.ai-thinking__shine`) — that shine can
 *  sweep off past the text entirely between passes without the word itself
 *  blinking out, which a single clipped layer can't do while resting. */
function ThinkingIndicator() {
  return (
    <div className="ai-thinking">
      <span className="ai-thinking__dot" aria-hidden />
      <span className="ai-thinking__label">
        Thinking…
        <span className="ai-thinking__shine" aria-hidden>
          Thinking…
        </span>
      </span>
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
