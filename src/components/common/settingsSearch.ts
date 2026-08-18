import { bestMatch } from "../../lib/fuzzyMatch";
import type { SettingsSection } from "../../state/store";

export type AppearanceSettingsSub = "interface" | "table" | "sidebar" | "editor";

export interface SettingsSearchItem {
  id: string;
  label: string;
  description: string;
  path: string;
  section: SettingsSection;
  appearanceSub?: AppearanceSettingsSub;
  targetId?: string;
  keywords?: string[];
}

/** Shared top-level Settings navigation. The dialog and Cmd/Ctrl+K palette
 *  both consume this so section names and destinations cannot drift. */
export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "general", label: "General", description: "Application behavior and data formats" },
  { id: "appearance", label: "Appearance", description: "Interface, table, sidebar, and editor appearance" },
  { id: "aiAssistant", label: "AI Assistant", description: "Provider, credentials, model, and reasoning" },
  { id: "shortcuts", label: "Keyboard Shortcuts", description: "Review and customize keyboard commands" },
];

/** Searchable user-facing settings. IDs are also attached to their rendered
 *  controls, so selecting a result can route and scroll without relying on
 *  fragile text or DOM-position matching. */
export const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  {
    id: "general.restore-tabs",
    label: "Restore tabs on launch",
    description: "Reopen database tabs after restarting CubbyDB.",
    path: "General",
    section: "general",
    targetId: "general.restore-tabs",
    keywords: ["session", "startup", "reopen"],
  },
  {
    id: "general.cubby-open-mode",
    label: "Close other tabs when opening a cubby",
    description: "Open a cubby onto a clean slate instead of alongside your open tabs.",
    path: "General",
    section: "general",
    targetId: "general.cubby-open-mode",
    keywords: ["cubby", "tabs", "clean slate", "replace"],
  },
  {
    id: "general.starter-sql",
    label: "Starter SQL",
    description: "Choose the SQL placed in new query tabs.",
    path: "General",
    section: "general",
    targetId: "general.starter-sql",
    keywords: ["template", "new query"],
  },
  {
    id: "general.auto-refresh",
    label: "Auto-refresh schema",
    description: "Reload database objects after connecting.",
    path: "General",
    section: "general",
    targetId: "general.auto-refresh",
    keywords: ["connect", "schema tree"],
  },
  {
    id: "general.history-limit",
    label: "Query history limit",
    description: "Choose how many recent query executions are shown.",
    path: "General",
    section: "general",
    targetId: "general.history-limit",
    keywords: ["recent", "entries"],
  },
  {
    id: "general.csv-delimiter",
    label: "CSV export delimiter",
    description: "Choose the separator used in exported CSV files.",
    path: "General",
    section: "general",
    targetId: "general.csv-delimiter",
    keywords: ["comma", "semicolon", "tab", "separator"],
  },
  {
    id: "general.copy-delimiter",
    label: "Row-copy delimiter",
    description: "Choose the separator used when copying result rows.",
    path: "General",
    section: "general",
    targetId: "general.copy-delimiter",
    keywords: ["clipboard", "paste", "separator"],
  },
  {
    id: "general.version",
    label: "Version and updates",
    description: "View the CubbyDB version or check for updates.",
    path: "General",
    section: "general",
    targetId: "general.version",
    keywords: ["release", "upgrade"],
  },
  {
    id: "appearance.theme",
    label: "Theme",
    description: "Choose a light or dark interface theme.",
    path: "Appearance · Interface",
    section: "appearance",
    appearanceSub: "interface",
    targetId: "appearance.theme",
    keywords: ["light", "dark", "paper", "midnight", "dracula", "one dark"],
  },
  {
    id: "appearance.accent",
    label: "Accent color",
    description: "Change the color used for actions and active states.",
    path: "Appearance · Interface",
    section: "appearance",
    appearanceSub: "interface",
    targetId: "appearance.accent",
    keywords: ["indigo", "blue", "green", "red", "highlight"],
  },
  {
    id: "appearance.compact-top-bar",
    label: "Compact top bar",
    description: "Hide the Postgres version beside the connection.",
    path: "Appearance · Interface",
    section: "appearance",
    appearanceSub: "interface",
    targetId: "appearance.compact-top-bar",
    keywords: ["header", "connection", "version"],
  },
  {
    id: "table.font",
    label: "Results table font",
    description: "Choose the typeface used for result data.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.font",
    keywords: ["grid", "typeface", "mono", "serif"],
  },
  {
    id: "table.font-size",
    label: "Results table font size",
    description: "Change the text size used in the results grid.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.font-size",
    keywords: ["grid", "text size"],
  },
  {
    id: "table.row-height",
    label: "Results table row height",
    description: "Change the density of rows in the results grid.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.row-height",
    keywords: ["grid", "density", "compact"],
  },
  {
    id: "table.zebra",
    label: "Zebra striping",
    description: "Tint alternating result rows.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.zebra",
    keywords: ["alternating rows", "grid"],
  },
  {
    id: "table.borders",
    label: "Cell borders",
    description: "Show gridlines between result cells.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.borders",
    keywords: ["gridlines", "dividers"],
  },
  {
    id: "table.header-shade",
    label: "Shade header row",
    description: "Darken the results-grid column header.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.header-shade",
    keywords: ["columns", "grid", "heading"],
  },
  {
    id: "table.wrap",
    label: "Wrap long result text",
    description: "Wrap cell values instead of truncating them.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.wrap",
    keywords: ["truncate", "cell"],
  },
  {
    id: "table.null-display",
    label: "NULL display",
    description: "Choose how SQL NULL values appear in results.",
    path: "Appearance · Table",
    section: "appearance",
    appearanceSub: "table",
    targetId: "table.null-display",
    keywords: ["blank", "dash", "value"],
  },
  {
    id: "sidebar.row-height",
    label: "Schema sidebar row height",
    description: "Change the density of the schema tree.",
    path: "Appearance · Sidebar",
    section: "appearance",
    appearanceSub: "sidebar",
    targetId: "sidebar.row-height",
    keywords: ["tree", "density", "compact"],
  },
  {
    id: "editor.font",
    label: "SQL editor font",
    description: "Choose the typeface used for SQL.",
    path: "Appearance · Editor",
    section: "appearance",
    appearanceSub: "editor",
    targetId: "editor.font",
    keywords: ["typeface", "code", "mono"],
  },
  {
    id: "editor.font-size",
    label: "SQL editor font size",
    description: "Change the text size used for SQL.",
    path: "Appearance · Editor",
    section: "appearance",
    appearanceSub: "editor",
    targetId: "editor.font-size",
    keywords: ["code", "text size"],
  },
  {
    id: "editor.line-wrap",
    label: "Wrap long SQL lines",
    description: "Wrap SQL instead of scrolling horizontally.",
    path: "Appearance · Editor",
    section: "appearance",
    appearanceSub: "editor",
    targetId: "editor.line-wrap",
    keywords: ["code", "horizontal scroll"],
  },
  {
    id: "ai.provider",
    label: "AI provider",
    description: "Choose what powers the read-only Ask AI assistant.",
    path: "AI Assistant",
    section: "aiAssistant",
    targetId: "ai.provider",
    keywords: ["OpenAI", "Anthropic", "Codex", "Claude Code"],
  },
  {
    id: "ai.credentials",
    label: "AI credentials and ChatGPT/Claude sign-in",
    description: "Manage an API key or Codex/Claude Code subscription login.",
    path: "AI Assistant",
    section: "aiAssistant",
    targetId: "ai.credentials",
    keywords: ["API key", "account", "Codex", "Claude Code", "OpenAI", "Anthropic", "login"],
  },
  {
    id: "ai.model",
    label: "AI model",
    description: "Choose the model used by Ask AI.",
    path: "AI Assistant",
    section: "aiAssistant",
    targetId: "ai.model",
    keywords: ["GPT", "Claude", "Codex", "Claude Code"],
  },
  {
    id: "ai.reasoning",
    label: "Reasoning level",
    description: "Choose the model's reasoning effort.",
    path: "AI Assistant",
    section: "aiAssistant",
    targetId: "ai.reasoning",
    keywords: ["effort", "medium", "high", "thinking"],
  },
];

export function searchSettings(
  items: SettingsSearchItem[],
  query: string,
  limit = 20,
): SettingsSearchItem[] {
  const normalized = query.trim();
  if (!normalized) return [];
  return items
    .flatMap((item) => {
      const match = bestMatch(normalized, [
        item.label,
        item.description,
        item.path,
        ...(item.keywords ?? []),
      ]);
      return match ? [{ item, score: match.score }] : [];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
