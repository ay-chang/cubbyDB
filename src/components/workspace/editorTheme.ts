/**
 * CodeMirror 6 theme + syntax highlighting for the SQL editor, transcribed from
 * the design spec: Geist Mono 13/22, keywords in accent indigo, strings green,
 * numbers amber, comments gray. Colors are pulled from CSS variables so the
 * editor stays in lockstep with the rest of the token system.
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const cssVar = (name: string, fallback: string) => `var(${name}, ${fallback})`;

const theme = EditorView.theme(
  {
    "&": {
      color: cssVar("--text", "#16181d"),
      backgroundColor: cssVar("--surface", "#ffffff"),
      fontSize: cssVar("--editor-font-size", "13px"),
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: cssVar("--editor-font", "'Geist Mono', monospace"),
      // Unitless so it scales automatically with the inherited font size above
      // (~22/13 at the default size) rather than needing a second variable.
      lineHeight: "1.7",
    },
    ".cm-content": {
      padding: "14px 0",
      caretColor: cssVar("--accent", "#5e6ad2"),
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-gutters": {
      backgroundColor: cssVar("--surface", "#ffffff"),
      color: cssVar("--text-ghost", "#c7cbd1"),
      border: "none",
      borderRight: `1px solid ${cssVar("--border-faint", "#f0f1f3")}`,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 16px",
      minWidth: "26px",
    },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: cssVar("--text-faint", "#8c9198"),
    },
    ".cm-cursor": {
      borderLeftColor: cssVar("--accent", "#5e6ad2"),
      borderLeftWidth: "1.5px",
    },
    ".cm-content, .cm-gutter": {
      minHeight: "100%",
    },
  },
  { dark: false },
);

/**
 * Selection, selection-match and matching-bracket colors, shared by the SQL
 * editor and the WHERE filter bar.
 *
 * Split out into its own theme (rather than living in `theme` above) for two
 * reasons, both about beating CodeMirror's own defaults rather than taste:
 *
 * 1. **Specificity.** The view's base theme styles the drawn selection with
 *    `&light.cm-focused > .cm-scroller > .cm-selectionLayer
 *    .cm-selectionBackground` — five classes. The obvious
 *    `.cm-selectionBackground` override is only two once the theme's marker
 *    class is prefixed, so it silently loses and the default wins. Every
 *    rule here mirrors the structure of the default it's replacing so it
 *    ties on specificity, which is enough: the base themes are registered at
 *    `Prec.lowest`, so a tie goes to us.
 * 2. **These editors are always tagged `&light`.** Both are constructed with
 *    `{dark: false}` (colors come from CSS variables, so there's no separate
 *    dark CodeMirror theme to switch to). That means the base theme's
 *    *light* branch applies under every one of our themes — including the
 *    dark ones, where its hardcoded `#d7d4f0` selection read as a washed-out
 *    lavender that swallowed the syntax colors underneath it.
 *
 * Note that `::selection` can't do this job: `drawSelection` (on via
 * `basicSetup`) forces native selection transparent with `!important`, so
 * the drawn layer is the only thing actually visible.
 */
export const cubbySelectionTheme = EditorView.theme({
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: cssVar("--accent-glow", "rgba(94,106,210,0.12)"),
  },
  // Unfocused (e.g. after clicking into the results grid) — softer, so it
  // reads as "this was selected" rather than competing with the live caret.
  "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: cssVar("--accent-glow-soft", "rgba(94,106,210,0.08)"),
  },
  // Other occurrences of the selected word (`highlightSelectionMatches`,
  // also on via `basicSetup`). Its default is a fully opaque `#99ff7780`
  // green that has nothing to do with the token system.
  ".cm-selectionMatch": {
    background: cssVar("--accent-glow-soft", "rgba(94,106,210,0.08)"),
    borderRadius: "2px",
  },
  // The selected range itself is already tinted by the selection layer;
  // stacking the match tint on top of it just muddies that one word.
  ".cm-selectionMatch-main": {
    background: "transparent",
  },
  "&.cm-focused .cm-matchingBracket": {
    background: cssVar("--accent-glow", "rgba(94,106,210,0.12)"),
    outline: `1px solid ${cssVar("--accent-tint-text", "#4a54b8")}`,
    borderRadius: "2px",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    background: cssVar("--error-bg", "#fcecec"),
    outline: `1px solid ${cssVar("--error-border", "#f3c6c7")}`,
    borderRadius: "2px",
  },
});

/**
 * Restyles `@codemirror/autocomplete`'s completion popup, which otherwise
 * renders with its own hardcoded light-mode colors (white background, blue
 * selection) via CodeMirror's baseTheme — completely ignoring both our token
 * system and the app's actual light/dark setting.
 *
 * Every selector below is plain (no `&light`/`&dark` — those tokens are only
 * valid inside `EditorView.baseTheme()`, not the regular `.theme()` used
 * here; using them throws a `RangeError` at construction time). A plain
 * selector still reliably wins over the base theme's `&light`/`&dark`
 * variants: `.theme()` implicitly prefixes every plain selector with this
 * theme's own marker class, which happens to land it at the same
 * specificity as the base theme's light/dark-scoped version, and normal
 * precedence beats the base theme's `Prec.lowest` on ties — the same
 * mechanism `.cm-gutters`/`.cm-activeLine` above already rely on.
 */
export const cubbyAutocompleteTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: cssVar("--surface", "#ffffff"),
    border: `1px solid ${cssVar("--border-strong", "#d5d8dd")}`,
    borderRadius: "10px",
    boxShadow: cssVar("--shadow-card", "0 12px 40px -18px rgba(20,24,40,0.28)"),
    padding: "4px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: cssVar("--font-mono", "monospace"),
    fontSize: "12.5px",
    minWidth: "260px",
    maxWidth: "460px",
    maxHeight: "16em",
    // Firefox; the WebKit equivalents are the ::-webkit-scrollbar rules below.
    scrollbarWidth: "thin",
    scrollbarColor: `${cssVar("--scrollbar-thumb", "#dfe1e5")} transparent`,
  },
  ".cm-tooltip-autocomplete > ul::-webkit-scrollbar": {
    width: "8px",
  },
  ".cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb": {
    background: cssVar("--scrollbar-thumb", "#dfe1e5"),
    borderRadius: "4px",
    border: "2px solid transparent",
    backgroundClip: "content-box",
  },
  ".cm-tooltip-autocomplete ul li": {
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "5px 9px",
    borderRadius: "6px",
    lineHeight: "1.5",
    color: cssVar("--text", "#16181d"),
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: cssVar("--accent", "#5e6ad2"),
    color: cssVar("--on-accent", "#ffffff"),
  },
  // CodeMirror's default type icons render as actual color emoji for some
  // types (notably the keyword "🔑") — the text-presentation variation
  // selector it appends doesn't reliably override that in every font, so
  // `color` can't restyle it. Rather than fight per-glyph emoji rendering,
  // the glyph is blanked below and replaced with a short text tag, which is
  // what actually distinguishes a column from a table from a keyword now
  // that all three share one list.
  ".cm-completionIcon": {
    flex: "none",
    boxSizing: "border-box",
    width: "30px",
    padding: "0",
    margin: "0",
    fontFamily: cssVar("--font-sans", "sans-serif"),
    fontSize: "9px",
    fontWeight: "600",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    textAlign: "left",
    color: cssVar("--text-fainter", "#a2a7ae"),
    opacity: "1",
  },
  ".cm-completionIcon::after": { content: "''" },
  ".cm-completionIcon-property::after": { content: "'col'" },
  ".cm-completionIcon-type::after": { content: "'tbl'" },
  ".cm-completionIcon-keyword::after": { content: "'kw'" },
  ".cm-completionIcon-constant::after": { content: "'as'" },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionIcon": {
    color: cssVar("--on-accent", "#ffffff"),
    opacity: "0.7",
  },
  ".cm-completionLabel": {
    flex: "1",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: cssVar("--accent", "#5e6ad2"),
    fontWeight: "600",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText": {
    color: cssVar("--on-accent", "#ffffff"),
    fontWeight: "700",
  },
  ".cm-completionDetail": {
    flex: "none",
    maxWidth: "150px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: cssVar("--font-sans", "sans-serif"),
    fontSize: "10.5px",
    color: cssVar("--text-faint", "#8c9198"),
    fontStyle: "normal",
    marginLeft: "auto",
    paddingLeft: "14px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": {
    color: cssVar("--on-accent", "#ffffff"),
    opacity: "0.75",
  },
  ".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after": {
    color: cssVar("--text-faint", "#8c9198"),
  },
  ".cm-tooltip.cm-completionInfo": {
    background: cssVar("--surface", "#ffffff"),
    border: `1px solid ${cssVar("--border-strong", "#d5d8dd")}`,
    borderRadius: "8px",
    boxShadow: cssVar("--shadow-card", "0 12px 40px -18px rgba(20,24,40,0.28)"),
    color: cssVar("--text", "#16181d"),
    fontSize: "12px",
    padding: "7px 10px",
  },
});

export const sqlHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: cssVar("--syntax-keyword", "#5e6ad2") },
  { tag: [t.string, t.special(t.string)], color: cssVar("--syntax-string", "#1f9d57") },
  { tag: [t.number, t.bool, t.null], color: cssVar("--syntax-number", "#b45309") },
  { tag: [t.lineComment, t.blockComment], color: cssVar("--syntax-comment", "#9aa0a6"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: cssVar("--text", "#16181d") },
  { tag: t.typeName, color: cssVar("--text-muted", "#5b6069") },
  { tag: t.propertyName, color: cssVar("--text", "#16181d") },
]);

export const cubbyEditorTheme = [
  theme,
  cubbySelectionTheme,
  cubbyAutocompleteTheme,
  syntaxHighlighting(sqlHighlightStyle),
];
