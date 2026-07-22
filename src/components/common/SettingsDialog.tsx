import { useState } from "react";

import { useStore } from "../../state/store";
import type { Delimiter, TableFont, Theme } from "../../state/store";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_TABLE_FONT_SIZE,
  DEFAULT_TABLE_ROW_HEIGHT,
  DELIMITER_LABELS,
  DELIMITER_OPTIONS,
  EDITOR_FONT_SIZE_OPTIONS,
  HISTORY_LIMIT_OPTIONS,
  NULL_DISPLAY_LABELS,
  TABLE_FONT_SIZE_OPTIONS,
  TABLE_FONT_STACKS,
  TABLE_ROW_HEIGHT_OPTIONS,
} from "../../state/store";
import type { NullDisplay } from "../../state/store";

/** Top-level settings tabs. The rail is built to grow beyond these two. */
type TopSection = "general" | "appearance";

const TOP_SECTIONS: { id: TopSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
];

/** Sub-tabs within the Appearance section. */
type AppearanceSub = "interface" | "table" | "editor";

const APPEARANCE_SUBS: { id: AppearanceSub; label: string }[] = [
  { id: "interface", label: "Interface" },
  { id: "table", label: "Table" },
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
          {section === "appearance" && appearanceSub === "editor" && <EditorSection />}
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
    </div>
  );
}

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Bright surfaces" },
  { id: "dark", label: "Dark", hint: "Dim, low-glare" },
];

function InterfaceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
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
