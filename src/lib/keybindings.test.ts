import { afterEach, describe, expect, it, vi } from "vitest";

import { bindingDisplayTokens, formatBinding, matchesKeybinding } from "./keybindings";

/** A `KeyboardEvent`-shaped fixture — `matchesKeybinding` only reads these
 *  five fields, so a full `KeyboardEvent` (which needs a DOM) isn't needed. */
function key(
  k: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
) {
  return {
    key: k,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe("matchesKeybinding", () => {
  it("returns false for a null binding", () => {
    expect(matchesKeybinding(key("k"), null)).toBe(false);
  });

  it("matches a plain key with no modifiers", () => {
    expect(matchesKeybinding(key("Escape"), "escape")).toBe(true);
    expect(matchesKeybinding(key("Escape", { shift: true }), "escape")).toBe(false);
  });

  it("matches an explicit modifier combo exactly", () => {
    expect(matchesKeybinding(key("f", { ctrl: true }), "ctrl+f")).toBe(true);
    // A held Meta the binding doesn't ask for must not also match — this is
    // what stops a rebound shortcut from firing at its old default too.
    expect(matchesKeybinding(key("f", { ctrl: true, meta: true }), "ctrl+f")).toBe(false);
  });

  it("requires every named modifier to be held, not a subset", () => {
    expect(matchesKeybinding(key("a", { ctrl: true }), "ctrl+shift+a")).toBe(false);
    expect(matchesKeybinding(key("a", { ctrl: true, shift: true }), "ctrl+shift+a")).toBe(true);
  });

  it("normalizes a Shift-produced symbol back to its base key", () => {
    // A US keyboard sends event.key "!" for Shift+1, not "1" with shiftKey.
    expect(matchesKeybinding(key("!", { shift: true }), "shift+1")).toBe(true);
    expect(matchesKeybinding(key("?", { shift: true }), "shift+/")).toBe(true);
  });

  it("normalizes the space key", () => {
    expect(matchesKeybinding(key(" "), "space")).toBe(true);
  });

  it("is case-insensitive on the key itself", () => {
    expect(matchesKeybinding(key("K", { meta: true }), "meta+k")).toBe(true);
  });

  describe("the 'mod' pseudo-modifier", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("resolves to Meta on macOS", () => {
      vi.stubGlobal("navigator", { platform: "MacIntel" });
      expect(matchesKeybinding(key("k", { meta: true }), "mod+k")).toBe(true);
      expect(matchesKeybinding(key("k", { ctrl: true }), "mod+k")).toBe(false);
    });

    it("resolves to Ctrl off macOS", () => {
      vi.stubGlobal("navigator", { platform: "Win32" });
      expect(matchesKeybinding(key("k", { ctrl: true }), "mod+k")).toBe(true);
      expect(matchesKeybinding(key("k", { meta: true }), "mod+k")).toBe(false);
    });
  });
});

describe("bindingDisplayTokens / formatBinding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders 'Not set' for a null binding", () => {
    expect(bindingDisplayTokens(null)).toEqual(["Not set"]);
  });

  it("renders mod as the platform's own symbol/word", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(formatBinding("mod+k")).toBe("⌘K");
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(formatBinding("mod+k")).toBe("Ctrl+K");
  });

  it("joins multiple tokens with no separator on macOS, '+' elsewhere", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(formatBinding("mod+shift+a")).toBe("⌘⇧A");
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(formatBinding("mod+shift+a")).toBe("Ctrl+Shift+A");
  });
});
