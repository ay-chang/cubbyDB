import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useRef, useState } from "react";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import { installUpdate } from "../../lib/appUpdate";
import {
  bindingDisplayTokens,
  bindingFromEvent,
  DEFAULT_KEYBINDINGS,
  findKeybindingConflict,
  isEditableKeybinding,
  isSafeBinding,
  KEYBINDING_DEFINITIONS,
  KEYBINDING_GROUPS,
  matchesKeybinding,
  reservedBindingLabel,
  type KeybindingId,
  useKeybindingStore,
} from "../../lib/keybindings";
import { useStore } from "../../state/store";
import type { Delimiter, SettingsSection, TableFont, Theme } from "../../state/store";
import type { AiModelInfo, AiProvider, AiReasoningEffort } from "../../types";
import { Toggle } from "./Toggle";
import {
  ACCENT_COLOR_LABELS,
  ACCENT_COLOR_OPTIONS,
  ACCENT_COLOR_SWATCH,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_SIDEBAR_ROW_HEIGHT,
  DEFAULT_TABLE_FONT_SIZE,
  DEFAULT_TABLE_ROW_HEIGHT,
  DELIMITER_LABELS,
  DELIMITER_OPTIONS,
  EDITOR_FONT_SIZE_OPTIONS,
  HISTORY_LIMIT_OPTIONS,
  NULL_DISPLAY_LABELS,
  SIDEBAR_ROW_HEIGHT_OPTIONS,
  TABLE_FONT_SIZE_OPTIONS,
  TABLE_FONT_STACKS,
  TABLE_ROW_HEIGHT_OPTIONS,
} from "../../state/store";
import type { NullDisplay } from "../../state/store";
import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTIONS,
  searchSettings,
  type AppearanceSettingsSub,
  type SettingsSearchItem,
} from "./settingsSearch";

/** Sub-tabs within the Appearance section. */
type AppearanceSub = AppearanceSettingsSub;

const APPEARANCE_SUBS: { id: AppearanceSub; label: string }[] = [
  { id: "interface", label: "Interface" },
  { id: "table", label: "Table" },
  { id: "sidebar", label: "Sidebar" },
  { id: "editor", label: "Editor" },
];

/**
 * The application settings modal, opened from the top bar. Its left rail
 * switches top-level sections and searches the complete settings catalog;
 * Appearance further splits into focused sub-tabs above its panel.
 */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const requestedSection = useStore((s) => s.settingsSection);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [appearanceSub, setAppearanceSub] = useState<AppearanceSub>("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedResult, setSelectedResult] = useState(0);
  const [searchTarget, setSearchTarget] = useState<{ id: string; nonce: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // The dialog stays mounted (just hidden) between opens, so its own
  // `section` state doesn't reset on its own — `openSettings(section)`
  // routes a one-shot directive through the store instead, which this syncs
  // onto local state whenever it's set (e.g. the AI panel's "Open Settings"
  // link landing straight on AI Assistant).
  useEffect(() => {
    if (open && requestedSection) setSection(requestedSection);
  }, [open, requestedSection]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      setSearchTarget(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnWindowShortcut = (event: KeyboardEvent) => {
      if (event.repeat || !matchesKeybinding(event, "mod+w")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", closeOnWindowShortcut);
    return () => window.removeEventListener("keydown", closeOnWindowShortcut);
  }, [close, open]);

  const searchableItems = useMemo(buildSettingsSearchCatalog, []);
  const searchResults = useMemo(
    () => searchSettings(searchableItems, searchQuery),
    [searchQuery, searchableItems],
  );

  useEffect(() => {
    setSelectedResult(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!searchQuery) return;
    cardRef.current
      ?.querySelector<HTMLElement>(`[data-settings-search-index="${selectedResult}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [searchQuery, selectedResult]);

  useEffect(() => {
    if (!searchTarget) return;
    let targetElement: HTMLElement | null = null;
    const frame = requestAnimationFrame(() => {
      targetElement = cardRef.current?.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(searchTarget.id)}"]`,
      ) ?? null;
      if (!targetElement) return;
      targetElement.scrollIntoView({ block: "center" });
      targetElement.classList.add("settings-search-target");
      targetElement
        .querySelector<HTMLElement>("button, input, select, textarea")
        ?.focus({ preventScroll: true });
    });
    const timeout = window.setTimeout(() => {
      targetElement?.classList.remove("settings-search-target");
    }, 1400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      targetElement?.classList.remove("settings-search-target");
    };
  }, [appearanceSub, searchTarget, section]);

  const openSearchResult = (item: SettingsSearchItem) => {
    setSection(item.section);
    if (item.appearanceSub) setAppearanceSub(item.appearanceSub);
    setSearchQuery("");
    setSearchTarget(item.targetId ? { id: item.targetId, nonce: Date.now() } : null);
  };

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        ref={cardRef}
        className="settings-card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="settings-rail">
          <div className="settings-rail__title caption">Settings</div>
          <div className="settings-search">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search settings…"
              aria-label="Search settings"
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchQuery) {
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchQuery("");
                } else if (event.key === "ArrowDown" && searchResults.length > 0) {
                  event.preventDefault();
                  setSelectedResult((value) => (value + 1) % searchResults.length);
                } else if (event.key === "ArrowUp" && searchResults.length > 0) {
                  event.preventDefault();
                  setSelectedResult(
                    (value) => (value - 1 + searchResults.length) % searchResults.length,
                  );
                } else if (event.key === "Enter") {
                  const result = searchResults[selectedResult];
                  if (result) {
                    event.preventDefault();
                    openSearchResult(result);
                  }
                }
              }}
            />
            {searchQuery && (
              <button
                className="settings-search__clear"
                onClick={() => setSearchQuery("")}
                title="Clear search"
                aria-label="Clear settings search"
              >
                ×
              </button>
            )}
          </div>

          {searchQuery ? (
            <div className="settings-search-results">
              {searchResults.length === 0 ? (
                <div className="settings-search-results__empty">No settings found.</div>
              ) : (
                searchResults.map((item, index) => (
                  <button
                    key={item.id}
                    data-settings-search-index={index}
                    className={
                      "settings-search-result" +
                      (index === selectedResult ? " settings-search-result--active" : "")
                    }
                    onMouseEnter={() => setSelectedResult(index)}
                    onClick={() => openSearchResult(item)}
                  >
                    <span className="settings-search-result__label">{item.label}</span>
                    <span className="settings-search-result__path">{item.path}</span>
                  </button>
                ))
              )}
            </div>
          ) : (
            SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={
                  "settings-rail__item" +
                  (section === s.id ? " settings-rail__item--active" : "")
                }
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))
          )}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel__head">
            <span className="settings-panel__title">
              {SETTINGS_SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              className="settings-panel__close"
              onClick={close}
              title="Close"
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          {section === "appearance" && (
            <div className="settings-subtabs">
              {APPEARANCE_SUBS.map((s) => (
                <button
                  key={s.id}
                  className={
                    "settings-subtab" +
                    (appearanceSub === s.id ? " settings-subtab--active" : "")
                  }
                  onClick={() => setAppearanceSub(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {section === "general" && <GeneralSection />}
          {section === "appearance" && appearanceSub === "interface" && (
            <InterfaceSection />
          )}
          {section === "appearance" && appearanceSub === "table" && <TableSection />}
          {section === "appearance" && appearanceSub === "sidebar" && <SidebarSection />}
          {section === "appearance" && appearanceSub === "editor" && <EditorSection />}
          {section === "aiAssistant" && <AiAssistantSection />}
          {section === "shortcuts" && <ShortcutsSection />}
        </div>
      </div>
    </div>
  );
}


function GeneralSection() {
  const restoreTabsOnLaunch = useStore((s) => s.restoreTabsOnLaunch);
  const setRestoreTabsOnLaunch = useStore((s) => s.setRestoreTabsOnLaunch);
  const closeTabsOnCubbyOpen = useStore((s) => s.closeTabsOnCubbyOpen);
  const setCloseTabsOnCubbyOpen = useStore((s) => s.setCloseTabsOnCubbyOpen);
  const starterSql = useStore((s) => s.starterSql);
  const setStarterSql = useStore((s) => s.setStarterSql);
  const autoRefreshSchema = useStore((s) => s.autoRefreshSchema);
  const setAutoRefreshSchema = useStore((s) => s.setAutoRefreshSchema);
  const historyLimit = useStore((s) => s.historyLimit);
  const setHistoryLimit = useStore((s) => s.setHistoryLimit);
  const csvDelimiter = useStore((s) => s.csvDelimiter);
  const setCsvDelimiter = useStore((s) => s.setCsvDelimiter);
  const rowCopyDelimiter = useStore((s) => s.rowCopyDelimiter);
  const setRowCopyDelimiter = useStore((s) => s.setRowCopyDelimiter);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setAppVersion);
  }, []);

  return (
    <div className="settings-section">
      <div className="settings-field settings-toggle-row" data-setting-id="general.restore-tabs">
        <div>
          <div className="settings-field__label">Restore tabs on launch</div>
          <div className="settings-field__desc">
            Reopen the tabs you had open last time you quit CubbyDB.
          </div>
        </div>
        <Toggle
          on={restoreTabsOnLaunch}
          onToggle={() => setRestoreTabsOnLaunch(!restoreTabsOnLaunch)}
        />
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="general.cubby-open-mode"
      >
        <div>
          <div className="settings-field__label">Close other tabs when opening a cubby</div>
          <div className="settings-field__desc">
            Open a cubby onto a clean slate — its own entries become the only
            open tabs. Off, a cubby's tabs are added alongside whatever you
            already had open.
          </div>
        </div>
        <Toggle
          on={closeTabsOnCubbyOpen}
          onToggle={() => setCloseTabsOnCubbyOpen(!closeTabsOnCubbyOpen)}
        />
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="general.starter-sql">
        <div className="settings-field__label">Starter SQL</div>
        <div className="settings-field__desc">
          Placeholder text pre-filled in every new query tab.
        </div>
        <textarea
          className="settings-textarea mono"
          value={starterSql}
          onChange={(e) => setStarterSql(e.target.value)}
          spellCheck={false}
          rows={3}
        />
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="general.auto-refresh"
      >
        <div>
          <div className="settings-field__label">Auto-refresh schema</div>
          <div className="settings-field__desc">
            Reload the schema tree automatically after connecting.
          </div>
        </div>
        <Toggle
          on={autoRefreshSchema}
          onToggle={() => setAutoRefreshSchema(!autoRefreshSchema)}
        />
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="general.history-limit">
        <div className="settings-field__label">Query history</div>
        <div className="settings-field__desc">
          How many recent entries the History panel fetches and shows.
        </div>
        <select
          className="settings-select"
          value={historyLimit}
          onChange={(e) => setHistoryLimit(Number(e.target.value))}
        >
          {HISTORY_LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} entries{n === DEFAULT_HISTORY_LIMIT ? " (default)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="general.csv-delimiter">
        <div className="settings-field__label">CSV export delimiter</div>
        <div className="settings-field__desc">
          Field separator used when exporting results to a .csv file.
        </div>
        <select
          className="settings-select"
          value={csvDelimiter}
          onChange={(e) => setCsvDelimiter(e.target.value as Delimiter)}
        >
          {DELIMITER_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {DELIMITER_LABELS[d]}
              {d === "," ? " (default)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="general.copy-delimiter">
        <div className="settings-field__label">Row-copy delimiter</div>
        <div className="settings-field__desc">
          Field separator used when copying rows to paste elsewhere (e.g. a
          spreadsheet).
        </div>
        <select
          className="settings-select"
          value={rowCopyDelimiter}
          onChange={(e) => setRowCopyDelimiter(e.target.value as Delimiter)}
        >
          {DELIMITER_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {DELIMITER_LABELS[d]}
              {d === "\t" ? " (default)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="general.version"
      >
        <div>
          <div className="settings-field__label">Version</div>
          <div className="settings-field__desc">
            {appVersion ? `CubbyDB ${appVersion}` : "…"}
          </div>
        </div>
        <UpdateCheckButton />
      </div>
    </div>
  );
}

/** The Ask AI panel's provider, credential route, and model. */
function AiAssistantSection() {
  const aiConfig = useStore((s) => s.aiConfig);
  const loadAiConfig = useStore((s) => s.loadAiConfig);
  const saveAiProvider = useStore((s) => s.saveAiProvider);
  const saveAiConfig = useStore((s) => s.saveAiConfig);
  const clearAiConfig = useStore((s) => s.clearAiConfig);
  const saveAiModel = useStore((s) => s.saveAiModel);
  const saveAiReasoningEffort = useStore((s) => s.saveAiReasoningEffort);
  const startCodexLogin = useStore((s) => s.startCodexLogin);
  const startClaudeCodeLogin = useStore((s) => s.startClaudeCodeLogin);
  const logoutCodex = useStore((s) => s.logoutCodex);
  const logoutClaudeCode = useStore((s) => s.logoutClaudeCode);

  useEffect(() => {
    if (!aiConfig) void loadAiConfig();
  }, [aiConfig, loadAiConfig]);

  // Never pre-filled with the real (never-returned) key.
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [codexSigningIn, setCodexSigningIn] = useState(false);
  const [codexLoginError, setCodexLoginError] = useState<string | null>(null);
  const [claudeCodeSigningIn, setClaudeCodeSigningIn] = useState(false);
  const [claudeCodeLoginError, setClaudeCodeLoginError] = useState<string | null>(null);

  const provider = aiConfig?.provider ?? "anthropic";
  const providerName =
    provider === "openai"
      ? "OpenAI"
      : provider === "codex"
        ? "Codex"
        : provider === "claudeCode"
          ? "Claude Code"
          : "Anthropic";
  const keySet =
    provider === "codex"
      ? (aiConfig?.codexAuthenticated ?? false)
      : provider === "claudeCode"
        ? (aiConfig?.claudeCodeAuthenticated ?? false)
        : provider === "openai"
          ? (aiConfig?.openaiKeySet ?? false)
          : (aiConfig?.anthropicKeySet ?? false);
  const keyHint = provider === "openai"
    ? aiConfig?.openaiKeyHint
    : provider === "anthropic"
      ? aiConfig?.anthropicKeyHint
      : null;
  const currentModel =
    provider === "codex"
      ? aiConfig?.codexModel
      : provider === "claudeCode"
        ? aiConfig?.claudeCodeModel
        : provider === "openai"
          ? aiConfig?.openaiModel
          : aiConfig?.anthropicModel;
  const currentReasoningEffort =
    provider === "codex"
      ? (aiConfig?.codexReasoningEffort ?? "medium")
      : provider === "claudeCode"
        ? (aiConfig?.claudeCodeReasoningEffort ?? "medium")
        : (aiConfig?.openaiReasoningEffort ?? "medium");

  // Live-fetched, not persisted anywhere — just what populates the dropdown.
  // Re-runs once a key becomes available (e.g. right after `handleSave`
  // below succeeds), so a freshly-saved key's models show up automatically.
  const [modelOptions, setModelOptions] = useState<AiModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const selectedModelInfo = modelOptions.find((model) => model.id === currentModel);
  const fallbackReasoningEfforts: AiReasoningEffort[] =
    provider === "claudeCode"
      ? ["low", "medium", "high", "xhigh", "max"]
      : currentModel?.startsWith("gpt-5.6")
        ? provider === "codex"
          ? ["low", "medium", "high", "xhigh", "max"]
          : ["none", "low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high"];
  const reasoningOptions = selectedModelInfo?.supportedReasoningEfforts.length
    ? selectedModelInfo.supportedReasoningEfforts
    : fallbackReasoningEfforts;

  useEffect(() => {
    if (!keySet) {
      setModelOptions([]);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    api
      .listAiModels()
      .then((models) => {
        if (!cancelled) setModelOptions(models);
      })
      .catch((err) => {
        if (!cancelled) setModelsError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keySet, provider]);

  const handleSave = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    void saveAiConfig(provider, trimmed).then(
      () => {
        setKeyInput("");
        setSaving(false);
      },
      () => setSaving(false),
    );
  };

  const handleCodexLogin = () => {
    setCodexSigningIn(true);
    setCodexLoginError(null);
    void startCodexLogin().then(
      () => setCodexSigningIn(false),
      (error) => {
        setCodexLoginError(errorMessage(error));
        setCodexSigningIn(false);
      },
    );
  };

  const handleClaudeCodeLogin = () => {
    setClaudeCodeSigningIn(true);
    setClaudeCodeLoginError(null);
    void startClaudeCodeLogin().then(
      () => setClaudeCodeSigningIn(false),
      (error) => {
        setClaudeCodeLoginError(errorMessage(error));
        setClaudeCodeSigningIn(false);
      },
    );
  };

  return (
    <div className="settings-section">
      <div className="settings-field" data-setting-id="ai.provider">
        <div className="settings-field__label">Provider</div>
        <div className="settings-field__desc">
          Choose what powers Ask AI. API keys and model choices stay separate, while Codex and
          Claude Code use your ChatGPT or Claude subscription through their own official CLIs.
        </div>
        <select
          className="settings-select"
          value={provider}
          onChange={(e) => {
            setKeyInput("");
            void saveAiProvider(e.target.value as AiProvider);
          }}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="codex">Codex subscription</option>
          <option value="claudeCode">Claude Code subscription</option>
        </select>
      </div>

      {provider === "claudeCode" ? (
        <div className="settings-field settings-field--spaced" data-setting-id="ai.credentials">
          <div className="settings-field__label">Claude account</div>
          {aiConfig?.claudeCodeAuthenticated ? (
            <div className="ai-credential-status ai-credential-status--set">
              <span className="ai-credential-status__dot" aria-hidden />
              <div className="ai-credential-status__body">
                <div className="ai-credential-status__primary">
                  <span>Signed in</span>
                  {aiConfig.claudeCodeEmail && (
                    <>
                      <span className="ai-credential-status__separator">as</span>
                      <span className="ai-credential-status__email mono">
                        {aiConfig.claudeCodeEmail}
                      </span>
                    </>
                  )}
                </div>
                <div className="ai-credential-status__meta">
                  {[
                    aiConfig.claudeCodePlanType ? `${aiConfig.claudeCodePlanType} plan` : null,
                    aiConfig.claudeCodeVersion ? `Claude Code CLI ${aiConfig.claudeCodeVersion}` : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button
                className="btn btn--outline ai-credential-status__logout"
                onClick={() => void logoutClaudeCode()}
              >
                Sign out
              </button>
            </div>
          ) : (
            <>
              <div
                className={
                  "ai-credential-status" +
                  (aiConfig?.claudeCodeError ? " ai-credential-status--error" : "")
                }
              >
                <span className="ai-credential-status__dot" aria-hidden />
                <div className="ai-credential-status__body">
                  <div className="ai-credential-status__primary">
                    {aiConfig?.claudeCodeError ? "Sign-in unavailable" : "Not signed in"}
                  </div>
                  <div className="ai-credential-status__meta">
                    {aiConfig?.claudeCodeError ??
                      "Sign in to use the allowance included with your Claude subscription."}
                  </div>
                </div>
              </div>
              <div className="settings-select-row">
                <button
                  className="btn btn--primary"
                  onClick={handleClaudeCodeLogin}
                  disabled={claudeCodeSigningIn || (aiConfig !== null && !aiConfig.claudeCodeInstalled)}
                >
                  {claudeCodeSigningIn ? "Waiting for browser…" : "Sign in with Claude"}
                </button>
              </div>
            </>
          )}
          {claudeCodeLoginError && (
            <div className="settings-field__desc settings-field__desc--error">
              {claudeCodeLoginError}
            </div>
          )}
          <div className="settings-field__desc">
            Uses the current Claude Code CLI profile, just like running `claude` in a terminal.
            Claude Code stores and refreshes the credential; CubbyDB never reads or copies the
            token.
          </div>
        </div>
      ) : provider === "codex" ? (
        <div className="settings-field settings-field--spaced" data-setting-id="ai.credentials">
          <div className="settings-field__label">ChatGPT account</div>
          {aiConfig?.codexAuthenticated ? (
            <div className="ai-credential-status ai-credential-status--set">
              <span className="ai-credential-status__dot" aria-hidden />
              <div className="ai-credential-status__body">
                <div className="ai-credential-status__primary">
                  <span>Signed in</span>
                  {aiConfig.codexEmail && (
                    <>
                      <span className="ai-credential-status__separator">as</span>
                      <span className="ai-credential-status__email mono">
                        {aiConfig.codexEmail}
                      </span>
                    </>
                  )}
                </div>
                <div className="ai-credential-status__meta">
                  {[
                    aiConfig.codexPlanType ? `${aiConfig.codexPlanType} plan` : null,
                    aiConfig.codexVersion ? `Codex CLI ${aiConfig.codexVersion}` : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button
                className="btn btn--outline ai-credential-status__logout"
                onClick={() => void logoutCodex()}
              >
                Sign out
              </button>
            </div>
          ) : (
            <>
              <div
                className={
                  "ai-credential-status" +
                  (aiConfig?.codexError ? " ai-credential-status--error" : "")
                }
              >
                <span className="ai-credential-status__dot" aria-hidden />
                <div className="ai-credential-status__body">
                  <div className="ai-credential-status__primary">
                    {aiConfig?.codexError ? "Sign-in unavailable" : "Not signed in"}
                  </div>
                  <div className="ai-credential-status__meta">
                    {aiConfig?.codexError ??
                      "Sign in to use the Codex allowance included with your ChatGPT plan."}
                  </div>
                </div>
              </div>
              <div className="settings-select-row">
                <button
                  className="btn btn--primary"
                  onClick={handleCodexLogin}
                  disabled={codexSigningIn || (aiConfig !== null && !aiConfig.codexInstalled)}
                >
                  {codexSigningIn ? "Waiting for browser…" : "Sign in with ChatGPT"}
                </button>
              </div>
            </>
          )}
          {codexLoginError && (
            <div className="settings-field__desc settings-field__desc--error">
              {codexLoginError}
            </div>
          )}
          <div className="settings-field__desc">
            Uses the current Codex CLI profile, just like running `codex` in a terminal. Codex
            stores and refreshes the credential; CubbyDB never reads or copies the token.
          </div>
        </div>
      ) : (
        <div className="settings-field settings-field--spaced" data-setting-id="ai.credentials">
          <div className="settings-field__label">{providerName} API key</div>
          <div className="settings-field__desc">
            Powers the Ask AI panel. The key stays in CubbyDB's local app-data file; only the
            masked identifier below is returned to the UI.
          </div>
          <div
            className={
              "ai-credential-status" +
              (keySet ? " ai-credential-status--set" : "")
            }
          >
            <span className="ai-credential-status__dot" aria-hidden />
            <div className="ai-credential-status__body">
              <div className="ai-credential-status__primary">
                {keySet ? "Configured" : "Not configured"}
              </div>
              <div className="ai-credential-status__meta mono">
                {keySet ? (keyHint ?? "Saved key") : `Add an ${providerName} API key to continue.`}
              </div>
            </div>
          </div>
          <div className="settings-select-row">
            <input
              className="settings-input"
              type="password"
              placeholder={
                keySet
                  ? "Enter a new key to replace the configured key"
                  : provider === "openai"
                    ? "sk-…"
                    : "sk-ant-…"
              }
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              spellCheck={false}
            />
            <button
              className="btn btn--primary"
              onClick={handleSave}
              disabled={!keyInput.trim() || saving}
            >
              {saving ? "Saving…" : keySet ? "Replace" : "Save"}
            </button>
            {keySet && (
              <button className="btn btn--outline" onClick={() => void clearAiConfig(provider)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <div className="settings-field settings-field--spaced" data-setting-id="ai.model">
        <div className="settings-field__label">Model</div>
        <div className="settings-field__desc">
          {modelsError
            ? `Couldn't load the model list: ${modelsError}`
            : !keySet
              ? provider === "codex"
                ? "Sign in with ChatGPT above to choose a model."
                : provider === "claudeCode"
                  ? "Sign in with Claude above to choose a model."
                  : "Add an API key above to choose a model."
              : modelsLoading
                ? "Loading available models…"
                : `Fetched live from ${providerName} — new models show up here automatically.`}
        </div>
        <select
          className="settings-select"
          value={currentModel ?? ""}
          disabled={!keySet}
          onChange={(e) => {
            const id = e.target.value;
            // Whether the model accepts the `effort` parameter is captured
            // here, from the live model list, and persisted with the choice.
            // Sending `effort` to a model that rejects it (Haiku 4.5) fails
            // every request, so an unknown model defaults to not sending it.
            const picked = modelOptions.find((m) => m.id === id);
            void (async () => {
              await saveAiModel(provider, id, picked?.supportsEffort ?? false);
              if (
                (provider === "openai" || provider === "codex" || provider === "claudeCode") &&
                picked?.supportedReasoningEfforts.length &&
                !picked.supportedReasoningEfforts.includes(currentReasoningEffort)
              ) {
                await saveAiReasoningEffort(
                  provider,
                  picked.defaultReasoningEffort ?? "medium",
                );
              }
            })();
          }}
        >
          {/* Keeps the resolved current model selectable even before the live
              list has loaded (or if it fails to) — the select is never empty
              or stuck on a value that isn't one of its own options. */}
          {currentModel && !modelOptions.some((m) => m.id === currentModel) && (
            <option value={currentModel}>{currentModel}</option>
          )}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {(provider === "openai" || provider === "codex" || provider === "claudeCode") && (
        <div className="settings-field settings-field--spaced" data-setting-id="ai.reasoning">
          <div className="settings-field__label">Reasoning level</div>
          <div className="settings-field__desc">
            Stored separately from the model. Higher levels can improve difficult answers but take
            longer and use more of your API or subscription allowance.
          </div>
          <select
            className="settings-select"
            value={currentReasoningEffort}
            disabled={!keySet || reasoningOptions.length === 0}
            onChange={(event) => {
              void saveAiReasoningEffort(
                provider,
                event.target.value as AiReasoningEffort,
              );
            }}
          >
            {!reasoningOptions.includes(currentReasoningEffort) && (
              <option value={currentReasoningEffort}>{reasoningLabel(currentReasoningEffort)}</option>
            )}
            {reasoningOptions.map((effort) => (
              <option key={effort} value={effort}>
                {reasoningLabel(effort)}
              </option>
            ))}
          </select>
        </div>
      )}

      {(provider === "codex" || provider === "claudeCode") && (
        <div className="settings-field__desc settings-field__desc--footnote">
          Connects your own {provider === "codex" ? "ChatGPT" : "Claude"} subscription account,
          not CubbyDB's. Using a subscription this way is governed by{" "}
          {provider === "codex" ? "OpenAI's" : "Anthropic's"} own terms, which may restrict
          third-party use — see cubbydb.com/terms.
        </div>
      )}
    </div>
  );
}

function reasoningLabel(effort: AiReasoningEffort): string {
  switch (effort) {
    case "none": return "None";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra high";
    case "max": return "Max";
    case "ultra": return "Ultra";
  }
}

/**
 * Manual counterpart to `UpdateBanner`'s silent launch-time check — same
 * `check()`/`installUpdate()` calls, but every state (checking, up to date,
 * available, error) is shown inline here since the user explicitly asked
 * for it, unlike the banner's silent-on-failure background check.
 */
function UpdateCheckButton() {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "upToDate" }
    | { kind: "available"; update: Update }
    | { kind: "installing" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const runCheck = () => {
    setState({ kind: "checking" });
    checkForUpdate()
      .then((update) => {
        setState(update ? { kind: "available", update } : { kind: "upToDate" });
      })
      .catch((e) => {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  };

  if (state.kind === "available") {
    return (
      <div className="settings-update-status">
        <span className="settings-update-status__text">
          v{state.update.version} available
        </span>
        <button
          className="btn btn--primary"
          onClick={() => {
            setState({ kind: "installing" });
            installUpdate(state.update).catch((e) => {
              setState({
                kind: "error",
                message: e instanceof Error ? e.message : String(e),
              });
            });
          }}
        >
          Update &amp; Restart
        </button>
      </div>
    );
  }

  return (
    <div className="settings-update-status">
      {state.kind === "upToDate" && (
        <span className="settings-update-status__text">Up to date</span>
      )}
      {state.kind === "error" && (
        <span className="settings-update-status__text settings-update-status__text--error">
          {state.message}
        </span>
      )}
      <button
        className="btn btn--outline"
        onClick={runCheck}
        disabled={state.kind === "checking" || state.kind === "installing"}
      >
        {state.kind === "checking"
          ? "Checking…"
          : state.kind === "installing"
            ? "Installing…"
            : "Check for Updates"}
      </button>
    </div>
  );
}

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Bright surfaces" },
  { id: "paper", label: "Paper", hint: "Warm, soft neutrals" },
  { id: "dark", label: "Dark", hint: "Dim, low-glare" },
  { id: "midnight", label: "Midnight", hint: "Deep, cool black" },
  { id: "charcoal", label: "Charcoal", hint: "Warm graphite gray" },
  { id: "slate", label: "Slate", hint: "Cool steel blue" },
  { id: "onedark", label: "One Dark", hint: "Atom/VS Code's classic dark" },
  { id: "dracula", label: "Dracula", hint: "Vivid purple, pink & yellow" },
];

function InterfaceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const accentColor = useStore((s) => s.accentColor);
  const setAccentColor = useStore((s) => s.setAccentColor);
  const compactTopBar = useStore((s) => s.compactTopBar);
  const setCompactTopBar = useStore((s) => s.setCompactTopBar);

  return (
    <div className="settings-section">
      <div className="settings-field" data-setting-id="appearance.theme">
        <div className="settings-field__label">Theme</div>
        <div className="settings-field__desc">
          Choose how CubbyDB looks. Your choice is saved for next time.
        </div>
        <div className="theme-choices">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={
                "theme-choice" +
                (theme === t.id ? " theme-choice--active" : "")
              }
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
            >
              <span className={`theme-choice__swatch theme-choice__swatch--${t.id}`}>
                <span className="theme-choice__swatch-bar" />
                <span className="theme-choice__swatch-dot" />
              </span>
              <span className="theme-choice__meta">
                <span className="theme-choice__label">{t.label}</span>
                <span className="theme-choice__hint">{t.hint}</span>
              </span>
              {theme === t.id && <span className="theme-choice__check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="appearance.accent">
        <div className="settings-field__label">Accent color</div>
        <div className="settings-field__desc">
          Pick the color used for buttons, active states, and SQL keyword
          highlighting.
        </div>
        <div className="accent-choices">
          {ACCENT_COLOR_OPTIONS.map((c) => (
            <button
              key={c}
              className={
                "accent-choice" +
                (accentColor === c ? " accent-choice--active" : "")
              }
              onClick={() => setAccentColor(c)}
              aria-pressed={accentColor === c}
              title={ACCENT_COLOR_LABELS[c]}
            >
              <span
                className="accent-choice__swatch"
                style={{ background: ACCENT_COLOR_SWATCH[c] }}
              >
                {accentColor === c && <span className="accent-choice__check">✓</span>}
              </span>
              <span className="accent-choice__label">{ACCENT_COLOR_LABELS[c]}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="appearance.compact-top-bar"
      >
        <div>
          <div className="settings-field__label">Compact top bar</div>
          <div className="settings-field__desc">
            Hide the Postgres version next to the connection name.
          </div>
        </div>
        <Toggle on={compactTopBar} onToggle={() => setCompactTopBar(!compactTopBar)} />
      </div>
    </div>
  );
}

const TABLE_FONTS: { id: TableFont; label: string; hint: string }[] = [
  { id: "sans", label: "Sans", hint: "Clean & modern (default)" },
  { id: "mono", label: "Classic Code", hint: "Monospace, tabular" },
  { id: "serif", label: "Serif", hint: "Editorial, easy to read" },
  { id: "system", label: "System", hint: "Your OS's native font" },
];

// Same 4 stacks as the table, but the editor's own default is the classic
// code font — so its hint text (which one says "(default)") differs.
const EDITOR_FONTS: { id: TableFont; label: string; hint: string }[] = [
  { id: "mono", label: "Classic Code", hint: "Monospace, tabular (default)" },
  { id: "sans", label: "Sans", hint: "Clean & modern" },
  { id: "serif", label: "Serif", hint: "Editorial, easy to read" },
  { id: "system", label: "System", hint: "Your OS's native font" },
];

const NULL_DISPLAYS: { id: NullDisplay; label: string }[] = [
  { id: "text", label: 'Text — "NULL" (default)' },
  { id: "dash", label: "Dash — —" },
  { id: "blank", label: "Blank — (nothing)" },
];

function TableSection() {
  const tableFont = useStore((s) => s.tableFont);
  const setTableFont = useStore((s) => s.setTableFont);
  const tableFontSize = useStore((s) => s.tableFontSize);
  const setTableFontSize = useStore((s) => s.setTableFontSize);
  const tableRowHeight = useStore((s) => s.tableRowHeight);
  const setTableRowHeight = useStore((s) => s.setTableRowHeight);
  const tableZebra = useStore((s) => s.tableZebra);
  const setTableZebra = useStore((s) => s.setTableZebra);
  const tableCellBorders = useStore((s) => s.tableCellBorders);
  const setTableCellBorders = useStore((s) => s.setTableCellBorders);
  const tableHeaderShade = useStore((s) => s.tableHeaderShade);
  const setTableHeaderShade = useStore((s) => s.setTableHeaderShade);
  const tableWrapText = useStore((s) => s.tableWrapText);
  const setTableWrapText = useStore((s) => s.setTableWrapText);
  const nullDisplay = useStore((s) => s.nullDisplay);
  const setNullDisplay = useStore((s) => s.setNullDisplay);

  return (
    <div className="settings-section">
      <div className="settings-field" data-setting-id="table.font">
        <div className="settings-field__label">Font</div>
        <div className="settings-field__desc">
          Choose the font used for data in the results grid. Your choice is
          saved for next time.
        </div>
        <div className="font-choices">
          {TABLE_FONTS.map((f) => (
            <button
              key={f.id}
              className={
                "font-choice" + (tableFont === f.id ? " font-choice--active" : "")
              }
              onClick={() => setTableFont(f.id)}
              aria-pressed={tableFont === f.id}
            >
              <span
                className="font-choice__sample"
                style={{ fontFamily: TABLE_FONT_STACKS[f.id] }}
              >
                Aa 123
              </span>
              <span className="font-choice__meta">
                <span className="font-choice__label">{f.label}</span>
                <span className="font-choice__hint">{f.hint}</span>
              </span>
              {tableFont === f.id && <span className="font-choice__check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="table.font-size">
        <div className="settings-field__label">Font size</div>
        <div className="settings-field__desc">
          Pick the exact size, in pixels, used for data in the results grid.
        </div>
        <div className="settings-select-row">
          <select
            className="settings-select"
            value={tableFontSize}
            onChange={(e) => setTableFontSize(Number(e.target.value))}
          >
            {TABLE_FONT_SIZE_OPTIONS.map((px) => (
              <option key={px} value={px}>
                {px}px{px === DEFAULT_TABLE_FONT_SIZE ? " (default)" : ""}
              </option>
            ))}
          </select>
          <span
            className="settings-select-preview"
            style={{ fontFamily: TABLE_FONT_STACKS[tableFont], fontSize: tableFontSize }}
          >
            Aa 123
          </span>
        </div>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="table.row-height">
        <div className="settings-field__label">Row height</div>
        <div className="settings-field__desc">
          Pick the exact row height, in pixels — shorter rows fit more on
          screen at once.
        </div>
        <div className="settings-select-row">
          <select
            className="settings-select"
            value={tableRowHeight}
            onChange={(e) => setTableRowHeight(Number(e.target.value))}
          >
            {TABLE_ROW_HEIGHT_OPTIONS.map(({ px, label }) => (
              <option key={px} value={px}>
                {px}px — {label}
                {px === DEFAULT_TABLE_ROW_HEIGHT ? " (default)" : ""}
              </option>
            ))}
          </select>
          <span
            className="settings-select-preview settings-select-preview--row"
            style={{ height: tableRowHeight }}
          >
            Row
          </span>
        </div>
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="table.zebra"
      >
        <div>
          <div className="settings-field__label">Zebra striping</div>
          <div className="settings-field__desc">
            Tint every other row for easier scanning.
          </div>
        </div>
        <Toggle on={tableZebra} onToggle={() => setTableZebra(!tableZebra)} />
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="table.borders"
      >
        <div>
          <div className="settings-field__label">Cell borders</div>
          <div className="settings-field__desc">
            Show gridlines between rows and columns.
          </div>
        </div>
        <Toggle
          on={tableCellBorders}
          onToggle={() => setTableCellBorders(!tableCellBorders)}
        />
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="table.header-shade"
      >
        <div>
          <div className="settings-field__label">Shade header row</div>
          <div className="settings-field__desc">
            Slightly darken the column-header row so it stands out more from
            the data below.
          </div>
        </div>
        <Toggle
          on={tableHeaderShade}
          onToggle={() => setTableHeaderShade(!tableHeaderShade)}
        />
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="table.wrap"
      >
        <div>
          <div className="settings-field__label">Wrap long text</div>
          <div className="settings-field__desc">
            Wrap cell text onto multiple lines instead of truncating it.
          </div>
        </div>
        <Toggle on={tableWrapText} onToggle={() => setTableWrapText(!tableWrapText)} />
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="table.null-display">
        <div className="settings-field__label">NULL display</div>
        <div className="settings-field__desc">
          How a SQL NULL value appears in the results grid.
        </div>
        <div className="settings-select-row">
          <select
            className="settings-select"
            value={nullDisplay}
            onChange={(e) => setNullDisplay(e.target.value as NullDisplay)}
          >
            {NULL_DISPLAYS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <span className="settings-select-preview settings-select-preview--null">
            {NULL_DISPLAY_LABELS[nullDisplay] || "(blank)"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Its own top-level sub-tab (not folded into Table/Interface) since more
 *  sidebar-specific settings are expected to land here over time. */
function SidebarSection() {
  const sidebarRowHeight = useStore((s) => s.sidebarRowHeight);
  const setSidebarRowHeight = useStore((s) => s.setSidebarRowHeight);

  return (
    <div className="settings-section">
      <div className="settings-field" data-setting-id="sidebar.row-height">
        <div className="settings-field__label">Row height</div>
        <div className="settings-field__desc">
          Pick the exact row height, in pixels, for the schema tree — shorter
          rows fit more tables and columns on screen at once.
        </div>
        <div className="settings-select-row">
          <select
            className="settings-select"
            value={sidebarRowHeight}
            onChange={(e) => setSidebarRowHeight(Number(e.target.value))}
          >
            {SIDEBAR_ROW_HEIGHT_OPTIONS.map(({ px, label }) => (
              <option key={px} value={px}>
                {px}px — {label}
                {px === DEFAULT_SIDEBAR_ROW_HEIGHT ? " (default)" : ""}
              </option>
            ))}
          </select>
          <span
            className="settings-select-preview settings-select-preview--row"
            style={{ height: sidebarRowHeight }}
          >
            Row
          </span>
        </div>
      </div>
    </div>
  );
}

function EditorSection() {
  const editorFont = useStore((s) => s.editorFont);
  const setEditorFont = useStore((s) => s.setEditorFont);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const setEditorFontSize = useStore((s) => s.setEditorFontSize);
  const editorLineWrap = useStore((s) => s.editorLineWrap);
  const setEditorLineWrap = useStore((s) => s.setEditorLineWrap);

  return (
    <div className="settings-section">
      <div className="settings-field" data-setting-id="editor.font">
        <div className="settings-field__label">Font</div>
        <div className="settings-field__desc">
          Choose the font used in the SQL editor. Your choice is saved for
          next time.
        </div>
        <div className="font-choices">
          {EDITOR_FONTS.map((f) => (
            <button
              key={f.id}
              className={
                "font-choice" + (editorFont === f.id ? " font-choice--active" : "")
              }
              onClick={() => setEditorFont(f.id)}
              aria-pressed={editorFont === f.id}
            >
              <span
                className="font-choice__sample"
                style={{ fontFamily: TABLE_FONT_STACKS[f.id] }}
              >
                Aa 123
              </span>
              <span className="font-choice__meta">
                <span className="font-choice__label">{f.label}</span>
                <span className="font-choice__hint">{f.hint}</span>
              </span>
              {editorFont === f.id && <span className="font-choice__check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field settings-field--spaced" data-setting-id="editor.font-size">
        <div className="settings-field__label">Font size</div>
        <div className="settings-field__desc">
          Pick the exact size, in pixels, used in the SQL editor.
        </div>
        <div className="settings-select-row">
          <select
            className="settings-select"
            value={editorFontSize}
            onChange={(e) => setEditorFontSize(Number(e.target.value))}
          >
            {EDITOR_FONT_SIZE_OPTIONS.map((px) => (
              <option key={px} value={px}>
                {px}px{px === DEFAULT_EDITOR_FONT_SIZE ? " (default)" : ""}
              </option>
            ))}
          </select>
          <span
            className="settings-select-preview"
            style={{ fontFamily: TABLE_FONT_STACKS[editorFont], fontSize: editorFontSize }}
          >
            SELECT 1;
          </span>
        </div>
      </div>

      <div
        className="settings-field settings-field--spaced settings-toggle-row"
        data-setting-id="editor.line-wrap"
      >
        <div>
          <div className="settings-field__label">Wrap long lines</div>
          <div className="settings-field__desc">
            Wrap long SQL lines instead of scrolling horizontally.
          </div>
        </div>
        <Toggle
          on={editorLineWrap}
          onToggle={() => setEditorLineWrap(!editorLineWrap)}
        />
      </div>
    </div>
  );
}

/**
 * Built-in focused-control interactions. Application commands are generated
 * from `KEYBINDING_DEFINITIONS` below so their documentation and runtime
 * bindings share one source of truth. Keep this fixed catalog in sync when a
 * focused control gains or loses a non-configurable interaction.
 */
const SHORTCUT_GROUPS: {
  title: string;
  shortcuts: { keys: string[]; desc: string }[];
}[] = [
  {
    title: "Settings dialog",
    shortcuts: [
      { keys: ["⌘", "W"], desc: "Close Settings without closing the database tab behind it" },
      { keys: ["⎋"], desc: "Clear the current Settings search" },
    ],
  },
  {
    title: "SQL editor",
    shortcuts: [
      { keys: ["⇥"], desc: "Accept the highlighted autocomplete suggestion, else indent" },
      { keys: ["⇧", "⇥"], desc: "Dedent the current line" },
      { keys: ["⌘", "Z"], desc: "Undo" },
      { keys: ["⌘", "⇧", "Z"], desc: "Redo" },
      { keys: ["Ctrl", "Space"], desc: "Open autocomplete suggestions" },
    ],
  },
  {
    title: "Table filter (WHERE bar)",
    shortcuts: [
      { keys: ["⏎"], desc: "Apply the typed filter" },
      { keys: ["⇥"], desc: "Accept the highlighted autocomplete suggestion" },
      { keys: ["⌘", "I"], desc: "Switch the filter bar between SQL and AI mode" },
      { keys: ["⏎"], desc: "In AI mode: write the filter from your description" },
      { keys: ["⎋"], desc: "In AI mode: dismiss what the AI reported" },
    ],
  },
  {
    title: "Results grid",
    shortcuts: [
      { keys: ["Click", "row #"], desc: "Select that row" },
      { keys: ["⇧", "Click row #"], desc: "Select a range of rows" },
      { keys: ["⌘", "Click row #"], desc: "Add or remove a row from the selection" },
      { keys: ["⌘", "C"], desc: "Copy the selected row(s), or the selected cell" },
      { keys: ["⌘", "V"], desc: "Paste over the selected row or cell" },
      { keys: ["⏎"], desc: "In Find: jump to the next match" },
      { keys: ["⇧", "⏎"], desc: "In Find: jump to the previous match" },
      { keys: ["⎋"], desc: "Close \"Find in results\"" },
      { keys: ["⏎"], desc: "While editing a cell: save the edited value" },
      { keys: ["⎋"], desc: "While editing a cell: cancel the edit" },
    ],
  },
  {
    title: "Command palette",
    shortcuts: [
      { keys: ["⇥"], desc: "Cycle scope forward: All → Tables → Columns → Scripts → History" },
      { keys: ["⇧", "⇥"], desc: "Cycle scope backward" },
      { keys: ["↑", "↓"], desc: "Move the highlighted result" },
      { keys: ["⏎"], desc: "Open or run the highlighted result" },
      { keys: ["⎋"], desc: "Close the palette" },
    ],
  },
  {
    title: "Saved queries panel",
    shortcuts: [
      { keys: ["⏎"], desc: "While renaming a saved query: save the new name" },
      { keys: ["⎋"], desc: "While renaming a saved query: cancel" },
    ],
  },
];

/** Add the shortcut registry and fixed focused-control interactions to the
 *  static preference catalog. Each source remains authoritative for its own
 *  labels, so Settings search cannot drift from the rendered shortcut list. */
function buildSettingsSearchCatalog(): SettingsSearchItem[] {
  const sections = SETTINGS_SECTIONS.map((item) => ({
    id: `section.${item.id}`,
    label: item.label,
    description: `Open ${item.label} settings.`,
    path: "Settings",
    section: item.id,
  }));
  const commands = KEYBINDING_DEFINITIONS.map((item) => ({
    id: `shortcut.${item.id}`,
    label: item.description,
    description: "Review or customize this application command.",
    path: `Keyboard Shortcuts · ${item.group}`,
    section: "shortcuts" as const,
    targetId: `shortcut.${item.id}`,
    keywords: ["keybinding", "hotkey", "command"],
  }));
  const builtIns = SHORTCUT_GROUPS.flatMap((group) =>
    group.shortcuts.map((shortcut, index) => ({
      id: `builtin.${group.title}.${index}`,
      label: shortcut.desc,
      description: `Built-in ${group.title.toLowerCase()} interaction.`,
      path: `Keyboard Shortcuts · ${group.title}`,
      section: "shortcuts" as const,
      targetId: `builtin.${group.title}.${index}`,
      keywords: [shortcut.keys.join(" "), "keybinding", "hotkey"],
    })),
  );
  return [...sections, ...SETTINGS_SEARCH_ITEMS, ...commands, ...builtIns];
}

function ShortcutsSection() {
  const bindings = useKeybindingStore((s) => s.bindings);
  const setBinding = useKeybindingStore((s) => s.setBinding);
  const resetBinding = useKeybindingStore((s) => s.resetBinding);
  const resetAll = useKeybindingStore((s) => s.resetAll);
  const [recordingId, setRecordingId] = useState<KeybindingId | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const hasCustomBindings = KEYBINDING_DEFINITIONS.some(
    (item) =>
      isEditableKeybinding(item.id) &&
      bindings[item.id] !== DEFAULT_KEYBINDINGS[item.id],
  );

  useEffect(() => {
    if (!recordingId) return;
    const definition = KEYBINDING_DEFINITIONS.find(
      (item) => item.id === recordingId,
    );
    if (!definition || !isEditableKeybinding(definition.id)) return;

    // Capture at the window boundary while recording. Relying on the button's
    // focus alone is brittle in a desktop webview: modifier chords can move
    // focus or be claimed by the app before the focused control receives the
    // key. preventDefault also ensures the shortcut being recorded never runs.
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;

      const binding = bindingFromEvent(event);
      if (!binding) return;
      if (!isSafeBinding(binding)) {
        setRecordError("Use Cmd/Ctrl with printable keys.");
        return;
      }
      const reserved = reservedBindingLabel(binding);
      if (reserved) {
        setRecordError(`${reserved} is reserved for standard text and grid editing.`);
        return;
      }
      const conflict = findKeybindingConflict(definition.id, binding, bindings);
      if (conflict) {
        setRecordError(`Already assigned to “${conflict.description}”.`);
        return;
      }
      setBinding(definition.id, binding);
      setRecordingId(null);
      setRecordError(null);
    };

    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [bindings, recordingId, setBinding]);

  return (
    <div className="settings-section">
      <div className="shortcut-intro">
        <div className="settings-field__desc">
          Click an editable shortcut, then press a new key combination.
          Platform conventions and focused-control interactions stay fixed.
        </div>
        <button
          className="shortcut-reset-all"
          onClick={() => {
            resetAll();
            setRecordingId(null);
            setRecordError(null);
          }}
          disabled={!hasCustomBindings}
        >
          Reset all
        </button>
      </div>

      {KEYBINDING_GROUPS.map((title) => (
        <div key={title} className="shortcut-group">
          <div className="shortcut-group__title">{title}</div>
          {KEYBINDING_DEFINITIONS.filter((item) => item.group === title).map((item) => {
            const binding = bindings[item.id];
            const editable = isEditableKeybinding(item.id);
            const isRecording = recordingId === item.id;
            const isCustom = binding !== DEFAULT_KEYBINDINGS[item.id];
            return (
              <div
                key={item.id}
                className="shortcut-row shortcut-row--command"
                data-setting-id={`shortcut.${item.id}`}
              >
                {editable ? (
                  <button
                    className={
                      "shortcut-binding" +
                      (isRecording ? " shortcut-binding--recording" : "") +
                      (!binding ? " shortcut-binding--empty" : "")
                    }
                    onClick={() => {
                      setRecordingId(isRecording ? null : item.id);
                      setRecordError(null);
                    }}
                    aria-pressed={isRecording}
                    aria-label={`Change shortcut for ${item.description}`}
                  >
                    {isRecording ? (
                      <span className="shortcut-binding__prompt">Press keys…</span>
                    ) : (
                      bindingDisplayTokens(binding).map((key, index) => (
                        <kbd key={`${key}-${index}`} className="shortcut-kbd">
                          {key}
                        </kbd>
                      ))
                    )}
                  </button>
                ) : (
                  <span className="shortcut-binding shortcut-binding--fixed">
                    {bindingDisplayTokens(binding).map((key, index) => (
                      <kbd key={`${key}-${index}`} className="shortcut-kbd">
                        {key}
                      </kbd>
                    ))}
                  </span>
                )}
                <div className="shortcut-row__body">
                  <span className="shortcut-row__desc">{item.description}</span>
                  {isRecording && recordError && (
                    <span className="shortcut-row__error">{recordError}</span>
                  )}
                </div>
                {editable ? (
                  <div className="shortcut-row__actions">
                    <button
                      className="shortcut-row__action"
                      onClick={() => {
                        setBinding(item.id, null);
                        setRecordingId(null);
                        setRecordError(null);
                      }}
                      disabled={!binding}
                      title="Remove shortcut"
                    >
                      Clear
                    </button>
                    <button
                      className="shortcut-row__action"
                      onClick={() => {
                        resetBinding(item.id);
                        setRecordingId(null);
                        setRecordError(null);
                      }}
                      disabled={!isCustom}
                      title="Restore default shortcut"
                    >
                      Reset
                    </button>
                  </div>
                ) : (
                  <span className="shortcut-row__fixed-label">Fixed</span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="shortcut-builtins__label">Built-in interactions</div>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="shortcut-group">
          <div className="shortcut-group__title">{group.title}</div>
          {group.shortcuts.map((s, i) => (
            <div
              key={i}
              className="shortcut-row"
              data-setting-id={`builtin.${group.title}.${i}`}
            >
              <span className="shortcut-row__keys">
                {s.keys.map((k, ki) => (
                  <kbd key={ki} className="shortcut-kbd">
                    {k === "⌘" ? bindingDisplayTokens("mod")[0] : k}
                  </kbd>
                ))}
              </span>
              <span className="shortcut-row__desc">{s.desc}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
