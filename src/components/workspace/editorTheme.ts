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
      fontSize: "13px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: cssVar("--font-mono", "'Geist Mono', monospace"),
      lineHeight: "22px",
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

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: cssVar("--syntax-keyword", "#5e6ad2") },
  { tag: [t.string, t.special(t.string)], color: cssVar("--syntax-string", "#1f9d57") },
  { tag: [t.number, t.bool, t.null], color: cssVar("--syntax-number", "#b45309") },
  { tag: [t.lineComment, t.blockComment], color: cssVar("--syntax-comment", "#9aa0a6"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: cssVar("--text", "#16181d") },
  { tag: t.typeName, color: cssVar("--text-muted", "#5b6069") },
  { tag: t.propertyName, color: cssVar("--text", "#16181d") },
]);

export const cubbyEditorTheme = [theme, syntaxHighlighting(highlight)];
