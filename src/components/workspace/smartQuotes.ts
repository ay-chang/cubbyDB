/**
 * A dedicated keybinding for typing `'`, used by both the SQL editor and the
 * WHERE filter bar in place of `@codemirror/autocomplete`'s `closeBrackets`
 * quote-pairing.
 *
 * `closeBrackets` decides whether a quote should open a pair by inspecting
 * the syntax tree (`probablyInString`) — but `@codemirror/lang-sql`'s
 * PostgreSQL grammar doesn't give that heuristic enough to go on, so in
 * practice it only pairs a quote typed into a *completely empty* document
 * and silently declines everywhere else (confirmed: `SELECT '` and even
 * bare `id '` both fail to pair). Rather than fight that grammar/heuristic
 * interaction, this reimplements just the two behaviors actually wanted —
 * independent of any syntax tree.
 */

import { EditorSelection } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

const insertSingleQuote: Command = (view) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (!range.empty) {
      // A selection: wrap it, same as typing any other bracket-like char
      // over a selection.
      return {
        changes: [
          { from: range.from, insert: "'" },
          { from: range.to, insert: "'" },
        ],
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      };
    }
    const pos = range.head;
    if (state.sliceDoc(pos, pos + 1) === "'") {
      // Already sitting right before a closing quote — type through it
      // instead of inserting a second one.
      return { range: EditorSelection.cursor(pos + 1) };
    }
    return {
      changes: { from: pos, insert: "''" },
      range: EditorSelection.cursor(pos + 1),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.type" }));
  return true;
};

export const singleQuoteKeymap: readonly KeyBinding[] = [
  { key: "'", run: insertSingleQuote },
];
