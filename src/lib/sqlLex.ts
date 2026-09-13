/**
 * A significant-token scan of PostgreSQL text: keywords, statement
 * boundaries, and nothing else.
 *
 * This is not a parser. It exists so that the handful of places that need to
 * ask a coarse question about a script — "is this read-only?", "does this
 * delete anything?" — all agree about the one genuinely fiddly part, which is
 * what *isn't* a keyword: single-quoted strings (with `''` escaping),
 * double-quoted identifiers, `$tag$` dollar-quoted bodies, line comments, and
 * nested block comments. A `DELETE` inside any of those is text, not a
 * command, and every caller here would otherwise have to rediscover that.
 *
 * Ported from the backend's own scan in `src-tauri/src/db/read_only.rs`, which
 * remains the authority for what Ask AI is allowed to execute.
 */

export type SqlToken =
  | { kind: "word"; word: string; start: number; end: number }
  | { kind: "semicolon"; start: number; end: number }
  | { kind: "other"; start: number; end: number };

/** Skips to just past the closing quote, honouring the doubled-quote escape. */
function skipQuoted(sql: string, from: number, quote: string): number {
  let i = from;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return i;
}

/** Postgres block comments nest, so this counts depth rather than stopping at
 *  the first close. */
function skipBlockComment(sql: string, from: number): number {
  let i = from;
  let depth = 1;
  while (i < sql.length && depth > 0) {
    if (sql.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

/** `$$`, `$tag$` — the delimiter, if one really opens here. */
function dollarQuoteDelimiter(sql: string, start: number): string | null {
  let i = start + 1;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
  return sql[i] === "$" ? sql.slice(start, i + 1) : null;
}

/**
 * Tokenize `sql`, dropping whitespace, comments, and the contents of quoted
 * runs. Words are upper-cased for comparison; `start`/`end` are offsets into
 * the original text, so a caller can slice the source back out for display.
 */
export function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i + 2);
    } else if (c === "'" || c === '"') {
      const start = i;
      i = skipQuoted(sql, i + 1, c);
      // A quoted run is a value or an identifier, never a command — but it
      // is still part of the statement, so it keeps a token.
      tokens.push({ kind: "other", start, end: i });
    } else if (c === "$") {
      const delimiter = dollarQuoteDelimiter(sql, i);
      if (delimiter) {
        const start = i;
        const end = sql.indexOf(delimiter, i + delimiter.length);
        i = end === -1 ? sql.length : end + delimiter.length;
        tokens.push({ kind: "other", start, end: i });
      } else {
        tokens.push({ kind: "other", start: i, end: i + 1 });
        i++;
      }
    } else if (c === ";") {
      tokens.push({ kind: "semicolon", start: i, end: i + 1 });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ kind: "word", word: sql.slice(start, i).toUpperCase(), start, end: i });
    } else {
      tokens.push({ kind: "other", start: i, end: i + 1 });
      i++;
    }
  }

  return tokens;
}

/** Splits a token stream at top-level `;` into one list per statement,
 *  dropping the separators and any empty run between them. */
export function splitTokenStatements(tokens: SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const token of tokens) {
    if (token.kind === "semicolon") {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}
