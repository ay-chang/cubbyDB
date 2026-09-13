/**
 * Finds the statements in a script that destroy data, so the editor can ask
 * before running them.
 *
 * Scope is deliberately narrow: things that *remove* rows or objects —
 * `DELETE`, `DROP`, `TRUNCATE`. `UPDATE` and `INSERT` are not included. They
 * change data too, but they are the ordinary traffic of a query tab, and a
 * prompt that fires on half of all scripts is one people learn to dismiss
 * without reading — which costs more safety than it buys.
 *
 * This is a keyword scan over `sqlLex`'s tokens, not a parser, so it errs
 * toward asking: a false prompt costs one click, a missed `DROP TABLE` costs
 * a table. The one thing it must not do is fire on a `DELETE` that is only
 * text — inside a string, a comment, or a quoted identifier — and the lexer
 * handles that.
 */

import { lexSql, splitTokenStatements, type SqlToken } from "./sqlLex";

/** Statements whose leading keyword is enough on its own. */
const DESTRUCTIVE_LEADING = new Set(["DELETE", "DROP", "TRUNCATE"]);

/** `ALTER ... DROP <these>` changes a column's rules rather than dropping the
 *  column, so it keeps every row it had. Anything else after `DROP` — a
 *  column, a constraint — takes data or structure with it. */
const HARMLESS_AFTER_ALTER_DROP = new Set(["DEFAULT", "NOT", "IDENTITY", "EXPRESSION"]);

/** How much of a statement to show. Long enough that the `WHERE` clause
 *  usually survives — that is the part worth re-reading — while still cutting
 *  off the pathological case, a `DELETE ... WHERE id IN (<10,000 ids>)`, which
 *  no one is going to audit by scrolling sideways through a modal. */
const PREVIEW_LIMIT = 160;

/** How many statements to list before summarizing the rest. The dialog opens
 *  collapsed and the expanded block scrolls, so this is not about fitting the
 *  list on screen — it is only a ceiling on how much SQL a pathological script
 *  can push into the DOM. Set high enough that the `-- …and N more` line is
 *  rare, so the two truncations (this one, and the collapse) hardly ever show
 *  up together. */
const MAX_LISTED = 50;

export interface DestructiveStatement {
  /** The verb this counted as: "DELETE", "DROP", or "TRUNCATE". */
  command: string;
  /** A one-line rendering of the statement, for the dialog. */
  preview: string;
}

/** Slices the original source back out and flattens it to one line. */
function previewOf(sql: string, statement: SqlToken[]): string {
  const from = statement[0].start;
  const to = statement[statement.length - 1].end;
  const text = sql.slice(from, to).replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;
}

/** Which verb, if any, makes this statement destructive. */
function classify(words: string[]): string | null {
  const lead = words[0];
  if (DESTRUCTIVE_LEADING.has(lead)) return lead;

  // `ALTER TABLE t DROP COLUMN c` / `DROP CONSTRAINT c`.
  if (lead === "ALTER") {
    const at = words.indexOf("DROP");
    if (at !== -1 && !HARMLESS_AFTER_ALTER_DROP.has(words[at + 1] ?? "")) return "DROP";
  }

  // A data-modifying CTE: `WITH gone AS (DELETE FROM t RETURNING *) SELECT …`
  // reads like a query but deletes rows.
  if (lead === "WITH" && words.includes("DELETE")) return "DELETE";

  return null;
}

/** Every destructive statement in `sql`, in the order they would run. */
export function findDestructiveStatements(sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];

  for (const statement of splitTokenStatements(lexSql(sql))) {
    const words = statement.flatMap((token) => (token.kind === "word" ? [token.word] : []));
    if (words.length === 0) continue;
    const command = classify(words);
    if (command) found.push({ command, preview: previewOf(sql, statement) });
  }

  return found;
}

/** What the dialog shows: one sentence, and the statements themselves as
 *  lines of a code block. Names them rather than warning in the abstract — the
 *  decision is about *these* statements, and a generic "are you sure?" gives
 *  the user nothing to check. The question itself is left to the confirm
 *  button ("Run anyway"). */
export interface DestructiveConfirmation {
  message: string;
  /** Lines for the code block, already one-lined and truncated. */
  statements: string[];
}

export function describeDestructiveRun(found: DestructiveStatement[]): DestructiveConfirmation {
  const statements = found.slice(0, MAX_LISTED).map((s) => s.preview);
  const rest = found.length - statements.length;
  // Phrased as a SQL comment so it sits in the code block without reading as
  // a statement of its own.
  if (rest > 0) statements.push(`-- …and ${rest} more`);

  const message =
    found.length === 1
      ? "This statement permanently removes data:"
      : `${found.length} statements in this script permanently remove data:`;

  return { message, statements };
}
