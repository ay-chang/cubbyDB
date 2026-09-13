/**
 * Does this statement fall inside what Ask AI is allowed to *execute*?
 *
 * A port of the backend gate in `src-tauri/src/db/read_only.rs` — same
 * allowlist, same forbidden words, same single-statement rule, same
 * treatment of quoted runs and comments (see `sqlLex.ts`). Keep the two in
 * step: this one is cosmetic (it decides whether a fenced block in a reply is
 * labelled as a change the assistant did not run), while the Rust one is the
 * actual boundary. Being a little conservative here is harmless; being wrong
 * there is not.
 *
 * The assistant is encouraged to write UPDATE/DELETE/DDL out for the user to
 * run themselves, so a fenced block that fails this check is a normal,
 * expected outcome — not an error to hide.
 */

import { lexSql } from "./sqlLex";

const ALLOWED_LEADING_WORDS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"]);

const FORBIDDEN_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE",
  "COPY", "CALL", "DO", "GRANT", "REVOKE", "COMMENT", "VACUUM", "REINDEX",
  "CLUSTER", "REFRESH", "DISCARD", "LISTEN", "UNLISTEN", "NOTIFY", "LOAD",
  "IMPORT", "REASSIGN", "SET", "RESET", "LOCK", "PREPARE", "EXECUTE",
  "DEALLOCATE", "DECLARE", "FETCH", "MOVE", "CLOSE", "BEGIN", "START",
  "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "CHECKPOINT", "INTO",
]);

/** True when the backend would execute this as-is: exactly one SELECT-family
 *  statement, with no write, DDL, session, transaction, or administrative
 *  word anywhere in it. */
export function isReadOnlySql(sql: string): boolean {
  const tokens = lexSql(sql);

  const first = tokens.find((token) => token.kind === "word");
  if (!first || first.kind !== "word" || !ALLOWED_LEADING_WORDS.has(first.word)) return false;
  if (tokens.some((token) => token.kind === "word" && FORBIDDEN_WORDS.has(token.word))) {
    return false;
  }

  // At most one semicolon, and only as the very last token — anything after
  // it is a second statement.
  const semicolons = tokens.flatMap((token, index) => (token.kind === "semicolon" ? [index] : []));
  if (semicolons.length > 1) return false;
  if (semicolons.length === 1 && semicolons[0] + 1 !== tokens.length) return false;

  return true;
}
