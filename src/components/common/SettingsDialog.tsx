import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";

import * as api from "../../api/backend";
import { errorMessage } from "../../api/backend";
import { installUpdate } from "../../lib/appUpdate";
import { useStore } from "../../state/store";
import type { Delimiter, TableFont, Theme } from "../../state/store";
import type { AiModelInfo } from "../../types";
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

/** Top-level settings tabs. The rail is built to grow beyond these four. */
type TopSection = "general" | "appearance" | "aiAssistant" | "shortcuts";

const TOP_SECTIONS: { id: TopSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "aiAssistant", label: "AI Assistant" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
];

/** Sub-tabs within the Appearance section. */
type AppearanceSub = "interface" | "table" | "sidebar" | "editor";

const APPEARANCE_SUBS: { id: AppearanceSub; label: string }[] = [
  { id: "interface", label: "Interface" },
  { id: "table", label: "Table" },
  { id: "sidebar", label: "Sidebar" },
  { id: "editor", label: "Editor" },
];

/**
 * The application settings modal, opened from the top bar. A left rail lists
 * top-level sections (General, Appearance); Appearance further splits into
 * sub-tabs (Interface, Table, Editor) shown as a strip at the top of its panel.
 */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const [section, setSection] = useState<TopSection>("appearance");
  const [appearanceSub, setAppearanceSub] = useState<AppearanceSub>("table");

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="settings-rail">
          <div className="settings-rail__title caption">Settings</div>
          {TOP_SECTIONS.map((s) => (
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
          ))}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel__head">
            <span className="settings-panel__title">
              {TOP_SECTIONS.find((s) => s.id === section)?.label}
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

/** Reusable pill toggle switch, used by every on/off setting. */
function Toggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      className={"toggle" + (on ? " toggle--on" : "")}
      onClick={onToggle}
    >
      <span className="toggle__thumb" />
    </button>
  );
}

function GeneralSection() {
  const restoreTabsOnLaunch = useStore((s) => s.restoreTabsOnLaunch);
  const setRestoreTabsOnLaunch = useStore((s) => s.setRestoreTabsOnLaunch);
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
      <div className="settings-field settings-toggle-row">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
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

/** The Ask AI panel's Anthropic API key + model. Bring-your-own-key only —
 *  Anthropic doesn't let a third-party app use a user's Claude.ai
 *  subscription in place of metered API billing, so there's no "sign in"
 *  option to offer here. */
function AiAssistantSection() {
  const aiConfig = useStore((s) => s.aiConfig);
  const loadAiConfig = useStore((s) => s.loadAiConfig);
  const saveAiConfig = useStore((s) => s.saveAiConfig);
  const clearAiConfig = useStore((s) => s.clearAiConfig);
  const saveAiModel = useStore((s) => s.saveAiModel);

  useEffect(() => {
    if (!aiConfig) void loadAiConfig();
  }, [aiConfig, loadAiConfig]);

  // Never pre-filled with the real (never-returned) key.
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

  const keySet = aiConfig?.anthropicKeySet ?? false;
  const currentModel = aiConfig?.anthropicModel;

  // Live-fetched, not persisted anywhere — just what populates the dropdown.
  // Re-runs once a key becomes available (e.g. right after `handleSave`
  // below succeeds), so a freshly-saved key's models show up automatically.
  const [modelOptions, setModelOptions] = useState<AiModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

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
  }, [keySet]);

  const handleSave = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    void saveAiConfig(trimmed).then(
      () => {
        setKeyInput("");
        setSaving(false);
      },
      () => setSaving(false),
    );
  };

  return (
    <div className="settings-section">
      <div className="settings-field">
        <div className="settings-field__label">Anthropic API key</div>
        <div className="settings-field__desc">
          Powers the Ask AI panel. Bring your own key — CubbyDB never sees your Claude.ai
          subscription, only the key you paste below.{" "}
          {keySet
            ? "A key is saved."
            : "No key saved yet — the Ask AI panel won't work until you add one."}
        </div>
        <div className="settings-select-row">
          <input
            className="settings-input"
            type="password"
            placeholder={keySet ? "•••• saved — enter a new key to replace it" : "sk-ant-…"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            spellCheck={false}
          />
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={!keyInput.trim() || saving}
          >
            Save
          </button>
          {keySet && (
            <button className="btn btn--outline" onClick={() => void clearAiConfig()}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="settings-field settings-field--spaced">
        <div className="settings-field__label">Model</div>
        <div className="settings-field__desc">
          {modelsError
            ? `Couldn't load the model list: ${modelsError}`
            : !keySet
              ? "Add an API key above to choose a model."
              : modelsLoading
                ? "Loading available models…"
                : "Fetched live from Anthropic — new models show up here automatically."}
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
            void saveAiModel(id, picked?.supportsEffort ?? false);
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
    </div>
  );
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
      <div className="settings-field">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
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
      <div className="settings-field">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
        <div>
          <div className="settings-field__label">Zebra striping</div>
          <div className="settings-field__desc">
            Tint every other row for easier scanning.
          </div>
        </div>
        <Toggle on={tableZebra} onToggle={() => setTableZebra(!tableZebra)} />
      </div>

      <div className="settings-field settings-field--spaced settings-toggle-row">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
        <div>
          <div className="settings-field__label">Wrap long text</div>
          <div className="settings-field__desc">
            Wrap cell text onto multiple lines instead of truncating it.
          </div>
        </div>
        <Toggle on={tableWrapText} onToggle={() => setTableWrapText(!tableWrapText)} />
      </div>

      <div className="settings-field settings-field--spaced">
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
      <div className="settings-field">
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
      <div className="settings-field">
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

      <div className="settings-field settings-field--spaced">
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

      <div className="settings-field settings-field--spaced settings-toggle-row">
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
 * The full catalog of keyboard shortcuts, grouped by where they're active.
 * Read-only for now — this documents current behavior, it doesn't configure
 * it. `⌘` doubles as Ctrl on Windows/Linux (every shortcut is bound to
 * `metaKey || ctrlKey`, not Mac-only).
 *
 * Keep this in sync whenever a shortcut is added, changed, or removed — see
 * the "keyboard shortcuts" convention in AGENTS.md.
 */
const SHORTCUT_GROUPS: { title: string; shortcuts: { keys: string[]; desc: string }[] }[] = [
  {
    title: "General",
    shortcuts: [
      { keys: ["⌘", "⏎"], desc: "Run the active tab's query" },
      { keys: ["⎋"], desc: "Cancel the running query" },
      { keys: ["⌘", "T"], desc: "New query tab" },
      { keys: ["⌘", "W"], desc: "Close the active tab" },
      { keys: ["⌘", "K"], desc: "Open the command palette" },
      {
        keys: ["⌘", "S"],
        desc: "Save the current query — or, on a table tab with unsaved cell edits, commit those edits",
      },
    ],
  },
  {
    title: "SQL editor",
    shortcuts: [
      { keys: ["⌘", "⏎"], desc: "Run the statement under the cursor, or the current selection" },
      { keys: ["⌘", "⇧", "⏎"], desc: "Run the entire buffer, regardless of cursor/selection" },
      { keys: ["⌘", "⇧", "E"], desc: "Run EXPLAIN on the statement under the cursor" },
      { keys: ["⌘", "⇧", "A"], desc: "Run EXPLAIN ANALYZE on the statement under the cursor" },
      { keys: ["⇥"], desc: "Accept the highlighted autocomplete suggestion, else indent" },
      { keys: ["⇧", "⇥"], desc: "Dedent the current line" },
      { keys: ["⌘", "Z"], desc: "Undo" },
      { keys: ["⌘", "⇧", "Z"], desc: "Redo" },
      { keys: ["⌘", "F"], desc: "Open the editor's own find & replace" },
      { keys: ["Ctrl", "Space"], desc: "Open autocomplete suggestions" },
    ],
  },
  {
    title: "Table filter (WHERE bar)",
    shortcuts: [
      { keys: ["⏎"], desc: "Apply the typed filter" },
      { keys: ["⇥"], desc: "Accept the highlighted autocomplete suggestion" },
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
      { keys: ["⌘", "F"], desc: "Open \"Find in results\"" },
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
      { keys: ["⌘", "K"], desc: "Open or close the palette" },
      { keys: ["⇥"], desc: "Cycle scope forward: All → Tables → Columns" },
      { keys: ["⇧", "⇥"], desc: "Cycle scope backward" },
      { keys: ["↑", "↓"], desc: "Move the highlighted result" },
      { keys: ["⏎"], desc: "Jump to the highlighted result" },
      { keys: ["⎋"], desc: "Close the palette" },
    ],
  },
  {
    title: "Connection screen",
    shortcuts: [
      { keys: ["⌘", "⏎"], desc: "Connect — or reconnect, if editing a saved connection" },
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

function ShortcutsSection() {
  return (
    <div className="settings-section">
      <div className="settings-field__desc">
        Every shortcut CubbyDB currently supports, grouped by where it's
        active. This list is read-only for now.
      </div>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="shortcut-group">
          <div className="shortcut-group__title">{group.title}</div>
          {group.shortcuts.map((s, i) => (
            <div key={i} className="shortcut-row">
              <span className="shortcut-row__keys">
                {s.keys.map((k, ki) => (
                  <kbd key={ki} className="shortcut-kbd">
                    {k}
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
