/**
 * Split a SQL script into top-level statements so "run current statement" can
 * find the one under the cursor. This is a lightweight scanner, not a real SQL
 * parser: it tracks single-quoted strings ('' escaping), double-quoted
 * identifiers, and line/block comments so a `;` inside any of those doesn't
 * end a statement.
 *
 * Known limitation: it does NOT understand Postgres dollar-quoted strings
 * (`$$ ... $$`, e.g. in `CREATE FUNCTION ... AS $$ ... $$`). A `;` inside a
 * dollar-quoted body will be treated as a statement boundary. Multi-statement
 * scripts containing dollar-quoted function bodies should be run as a whole
 * (Cmd/Ctrl+Shift+Enter) rather than statement-by-statement.
 */

export interface StatementRange {
  start: number;
  end: number;
}

/** Byte-offset ranges of each non-empty top-level statement in `sql`. */
export function splitStatements(sql: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let stmtStart = 0;
  let i = 0;
  const n = sql.length;

  const pushIfNonEmpty = (end: number) => {
    const slice = sql.slice(stmtStart, end);
    if (slice.trim().length > 0) {
      // Trim the range itself so callers get a clean slice.
      const leading = slice.length - slice.trimStart().length;
      const trimmedLen = slice.trim().length;
      ranges.push({ start: stmtStart + leading, end: stmtStart + leading + trimmedLen });
    }
  };

  while (i < n) {
    const c = sql[i];

    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // escaped quote
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    if (c === ";") {
      pushIfNonEmpty(i);
      i++;
      stmtStart = i;
      continue;
    }

    i++;
  }

  pushIfNonEmpty(n);
  return ranges;
}

/**
 * The statement range containing `pos` (a cursor offset into `sql`). If `pos`
 * falls in the gap between two statements (whitespace, or just after a `;`),
 * returns the next statement; if it's past the last one, returns the last.
 * Returns `null` only if the script has no non-empty statements at all.
 */
export function statementAt(sql: string, pos: number): StatementRange | null {
  const ranges = splitStatements(sql);
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (pos <= r.end) return r;
  }
  return ranges[ranges.length - 1];
}
