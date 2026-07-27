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
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: cssVar("--accent-glow", "rgba(94,106,210,0.12)"),
      },
    ".cm-content, .cm-gutter": {
      minHeight: "100%",
    },
  },
  { dark: false },
);

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
    borderRadius: "8px",
    boxShadow: cssVar("--shadow-card", "0 12px 40px -18px rgba(20,24,40,0.28)"),
    padding: "4px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: cssVar("--font-mono", "monospace"),
    fontSize: "12.5px",
    minWidth: "220px",
  },
  ".cm-tooltip-autocomplete ul li": {
    display: "flex",
    alignItems: "center",
    padding: "6px 8px",
    borderRadius: "6px",
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
  // drop the icon column entirely — it matches the app's existing list
  // style elsewhere (context menus, saved-connection cards) anyway, which
  // is text-first with no per-row type icons.
  ".cm-completionIcon": {
    display: "none",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: cssVar("--accent", "#5e6ad2"),
    fontWeight: "600",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText": {
    color: cssVar("--on-accent", "#ffffff"),
  },
  ".cm-completionDetail": {
    color: cssVar("--text-faint", "#8c9198"),
    fontStyle: "normal",
    marginLeft: "auto",
    paddingLeft: "12px",
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
  cubbyAutocompleteTheme,
  syntaxHighlighting(sqlHighlightStyle),
];
