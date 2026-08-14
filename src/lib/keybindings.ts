import { create } from "zustand";

export const TAB_JUMP_KEYBINDING_IDS = [
  "workspace.tab1",
  "workspace.tab2",
  "workspace.tab3",
  "workspace.tab4",
  "workspace.tab5",
  "workspace.tab6",
  "workspace.tab7",
  "workspace.tab8",
  "workspace.tab9",
] as const;

export type KeybindingContext = "workspace" | "connection";

export const KEYBINDING_GROUPS = [
  "General",
  "Tab navigation",
  "SQL editor",
  "Results grid",
  "Connection screen",
] as const;

export type KeybindingGroup = (typeof KEYBINDING_GROUPS)[number];

interface KeybindingDefinitionShape {
  id: string;
  group: KeybindingGroup;
  description: string;
  defaultBinding: string;
  context: KeybindingContext;
  editable?: boolean;
}

/**
 * Application commands and their defaults. Native text-editing interactions
 * stay owned by the focused control and are listed separately in Settings.
 */
export const KEYBINDING_DEFINITIONS = [
  {
    id: "workspace.newQuery",
    group: "General",
    description: "Open a new query tab",
    defaultBinding: "mod+t",
    context: "workspace",
  },
  {
    id: "workspace.newConnection",
    group: "General",
    description: "Open a new connection",
    defaultBinding: "mod+shift+n",
    context: "workspace",
  },
  {
    id: "workspace.save",
    group: "General",
    description: "Save the query, or commit pending table edits",
    defaultBinding: "mod+s",
    context: "workspace",
  },
  {
    id: "workspace.refresh",
    group: "General",
    description: "Refresh the schema and active tab data",
    defaultBinding: "mod+r",
    context: "workspace",
  },
  {
    id: "workspace.commandPalette",
    group: "General",
    description: "Open the workspace command palette",
    defaultBinding: "mod+k",
    context: "workspace",
  },
  {
    id: "workspace.toggleSidebar",
    group: "General",
    description: "Show or hide the schema sidebar",
    defaultBinding: "mod+b",
    context: "workspace",
  },
  {
    id: "workspace.toggleAiPanel",
    group: "General",
    description: "Show or hide the Ask AI panel",
    // Not mod+shift+a — that's already EXPLAIN ANALYZE in the SQL editor.
    defaultBinding: "mod+j",
    context: "workspace",
  },
  {
    id: "workspace.closeTab",
    group: "General",
    description: "Close the active tab",
    defaultBinding: "mod+w",
    context: "workspace",
  },
  {
    id: "workspace.openSettings",
    group: "General",
    description: "Open Settings",
    defaultBinding: "mod+,",
    context: "workspace",
    editable: false,
  },
  {
    id: "workspace.previousTab",
    group: "Tab navigation",
    description: "Switch to the previous database tab",
    defaultBinding: "mod+shift+[",
    context: "workspace",
  },
  {
    id: "workspace.nextTab",
    group: "Tab navigation",
    description: "Switch to the next database tab",
    defaultBinding: "mod+shift+]",
    context: "workspace",
  },
  {
    id: "workspace.navigateBack",
    group: "Tab navigation",
    description: "Go back to the previously active tab",
    defaultBinding: "mod+[",
    context: "workspace",
  },
  {
    id: "workspace.navigateForward",
    group: "Tab navigation",
    description: "Go forward again after navigating back",
    defaultBinding: "mod+]",
    context: "workspace",
  },
  ...TAB_JUMP_KEYBINDING_IDS.map((id, index) => ({
    id,
    group: "Tab navigation" as const,
    description: `Switch to database tab ${index + 1}`,
    defaultBinding: `mod+${index + 1}`,
    context: "workspace" as const,
  })),
  {
    id: "query.run",
    group: "SQL editor",
    description: "Run the selection or statement under the cursor",
    defaultBinding: "mod+enter",
    context: "workspace",
  },
  {
    id: "query.runAll",
    group: "SQL editor",
    description: "Run the entire SQL buffer",
    defaultBinding: "mod+shift+enter",
    context: "workspace",
  },
  {
    id: "query.explain",
    group: "SQL editor",
    description: "Run EXPLAIN on the current statement",
    defaultBinding: "mod+shift+e",
    context: "workspace",
  },
  {
    id: "query.explainAnalyze",
    group: "SQL editor",
    description: "Run EXPLAIN ANALYZE on the current statement",
    defaultBinding: "mod+shift+a",
    context: "workspace",
  },
  {
    id: "query.cancel",
    group: "SQL editor",
    description: "Cancel the running query",
    defaultBinding: "escape",
    context: "workspace",
  },
  {
    id: "results.find",
    group: "Results grid",
    description: "Find a value in the current results",
    defaultBinding: "mod+f",
    context: "workspace",
  },
  {
    id: "results.jumpColumn",
    group: "Results grid",
    description: "Jump to a result column by name",
    defaultBinding: "mod+g",
    context: "workspace",
  },
  {
    id: "connection.connect",
    group: "Connection screen",
    description: "Connect or reconnect with the current form",
    defaultBinding: "mod+enter",
    context: "connection",
  },
] as const satisfies readonly KeybindingDefinitionShape[];

export type KeybindingId = (typeof KEYBINDING_DEFINITIONS)[number]["id"];
export type KeybindingDefinition = (typeof KEYBINDING_DEFINITIONS)[number];

export type KeybindingMap = Record<KeybindingId, string | null>;

const STORAGE_KEY = "cubbydb:keybindings:v1";
const IDS = new Set<KeybindingId>(KEYBINDING_DEFINITIONS.map((item) => item.id));

export const DEFAULT_KEYBINDINGS = Object.fromEntries(
  KEYBINDING_DEFINITIONS.map((item) => [item.id, item.defaultBinding]),
) as KeybindingMap;

export function isEditableKeybinding(id: KeybindingId): boolean {
  const definition: KeybindingDefinitionShape | undefined =
    KEYBINDING_DEFINITIONS.find((item) => item.id === id);
  return definition !== undefined && definition.editable !== false;
}

function loadKeybindings(): KeybindingMap {
  const bindings = { ...DEFAULT_KEYBINDINGS };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    for (const [id, binding] of Object.entries(parsed)) {
      if (
        IDS.has(id as KeybindingId) &&
        isEditableKeybinding(id as KeybindingId) &&
        (typeof binding === "string" || binding === null)
      ) {
        bindings[id as KeybindingId] = binding;
      }
    }
  } catch {
    // Missing, unavailable, or malformed storage falls back to safe defaults.
  }
  return bindings;
}

function saveKeybindings(bindings: KeybindingMap) {
  try {
    const overrides: Partial<KeybindingMap> = {};
    for (const item of KEYBINDING_DEFINITIONS) {
      if (
        isEditableKeybinding(item.id) &&
        bindings[item.id] !== DEFAULT_KEYBINDINGS[item.id]
      ) {
        overrides[item.id] = bindings[item.id];
      }
    }
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // Storage can be unavailable in non-webview contexts; shortcuts still work.
  }
}

interface KeybindingStore {
  bindings: KeybindingMap;
  setBinding: (id: KeybindingId, binding: string | null) => void;
  resetBinding: (id: KeybindingId) => void;
  resetAll: () => void;
}

export const useKeybindingStore = create<KeybindingStore>((set) => ({
  bindings: loadKeybindings(),
  setBinding(id, binding) {
    if (!isEditableKeybinding(id)) return;
    set((state) => {
      const bindings = { ...state.bindings, [id]: binding };
      saveKeybindings(bindings);
      return { bindings };
    });
  },
  resetBinding(id) {
    if (!isEditableKeybinding(id)) return;
    set((state) => {
      const bindings = { ...state.bindings, [id]: DEFAULT_KEYBINDINGS[id] };
      saveKeybindings(bindings);
      return { bindings };
    });
  },
  resetAll() {
    const bindings = { ...DEFAULT_KEYBINDINGS };
    saveKeybindings(bindings);
    set({ bindings });
  },
}));

const SHIFTED_KEYS: Record<string, string> = {
  "{": "[",
  "}": "]",
  "<": ",",
  ">": ".",
  "?": "/",
  ":": ";",
  '"': "'",
  "|": "\\",
  "_": "-",
  "+": "=",
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

function normalizeEventKey(event: Pick<KeyboardEvent, "key">): string {
  const raw = event.key;
  if (SHIFTED_KEYS[raw]) return SHIFTED_KEYS[raw];
  const key = raw.toLowerCase();
  if (key === " ") return "space";
  if (key === "esc") return "escape";
  return key;
}

/** Exact shortcut matching: extra modifiers never accidentally trigger a command. */
export function matchesKeybinding(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  binding: string | null,
): boolean {
  if (!binding) return false;
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  const mod = parts.includes("mod");
  return (
    normalizeEventKey(event) === key &&
    event.metaKey === (parts.includes("meta") || (mod && isMac())) &&
    event.ctrlKey === (parts.includes("ctrl") || (mod && !isMac())) &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift")
  );
}

const MODIFIER_KEYS = new Set([
  "alt",
  "option",
  "control",
  "meta",
  "os",
  "command",
  "shift",
]);

/** Convert a recording keydown to the stable, platform-neutral storage form. */
export function bindingFromEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | undefined {
  const key = normalizeEventKey(event);
  if (MODIFIER_KEYS.has(key)) return undefined;
  const parts: string[] = [];
  if (isMac()) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** Avoid bindings such as a bare letter that would make ordinary typing unsafe. */
export function isSafeBinding(binding: string): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  if (
    parts.includes("mod") ||
    parts.includes("ctrl") ||
    parts.includes("meta")
  ) {
    return true;
  }
  return key === "escape" || key === "enter" || /^f\d{1,2}$/.test(key);
}

export function findKeybindingConflict(
  id: KeybindingId,
  binding: string,
  bindings: KeybindingMap,
): KeybindingDefinition | null {
  const current = KEYBINDING_DEFINITIONS.find((item) => item.id === id);
  if (!current) return null;
  return (
    KEYBINDING_DEFINITIONS.find(
      (item) => item.id !== id && item.context === current.context && bindings[item.id] === binding,
    ) ?? null
  );
}

const RESERVED_BINDINGS: Record<string, string> = {
  "mod+a": "Select all",
  "mod+c": "Copy",
  "mod+v": "Paste",
  "mod+x": "Cut",
  "mod+z": "Undo",
  "mod+shift+z": "Redo",
  "mod+y": "Redo",
};

/** Native editing commands must keep working in connection forms and SQL. */
export function reservedBindingLabel(binding: string): string | null {
  return RESERVED_BINDINGS[binding] ?? null;
}

const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  "[": "[",
  "]": "]",
};

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Tokens are rendered as separate <kbd> elements in Settings. */
export function bindingDisplayTokens(binding: string | null): string[] {
  if (!binding) return ["Not set"];
  const mac = isMac();
  return binding.split("+").map((part) => {
    if (part === "mod") return mac ? "⌘" : "Ctrl";
    if (part === "ctrl") return mac ? "⌃" : "Ctrl";
    if (part === "meta") return mac ? "⌘" : "Meta";
    if (part === "alt") return mac ? "⌥" : "Alt";
    if (part === "shift") return mac ? "⇧" : "Shift";
    return KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part);
  });
}

export function formatBinding(binding: string | null): string {
  return bindingDisplayTokens(binding).join(isMac() ? "" : "+");
}

export function formatShortcutTitle(label: string, binding: string | null): string {
  return binding ? `${label} (${formatBinding(binding)})` : label;
}

/** CodeMirror uses Mod/Shift/Alt dash syntax instead of the persisted form. */
export function bindingToCodeMirror(binding: string | null): string | null {
  if (!binding) return null;
  return binding
    .split("+")
    .map((part) => {
      if (part === "mod") return "Mod";
      if (part === "ctrl") return "Ctrl";
      if (part === "meta") return "Meta";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "enter") return "Enter";
      if (part === "escape") return "Escape";
      if (part === "space") return "Space";
      return part;
    })
    .join("-");
}
