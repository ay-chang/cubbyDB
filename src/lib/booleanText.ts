import type { QueryResult } from "../types";

/** Rewrite boolean columns' `t`/`f` (Postgres's text form) as `true`/`false`,
 *  so every view of a result — the grid, cell editor, copy, export — shows
 *  the spelled-out value, which Postgres also accepts back as input.
 *
 *  A column counts as boolean when its reported type is `bool`. Without a
 *  type, it's inferred: every non-null value is exactly `t` or `f`, which
 *  nothing else in Postgres serializes to. */
export function normalizeBooleanText(result: QueryResult): QueryResult {
  const boolCols = result.columns.map((col, i) =>
    col.dataType != null ? col.dataType === "bool" : allTOrF(result.rows, i),
  );
  if (!boolCols.some(Boolean)) return result;
  return {
    ...result,
    rows: result.rows.map((row) =>
      row.map((v, i) => (boolCols[i] && v === "t" ? "true" : boolCols[i] && v === "f" ? "false" : v)),
    ),
  };
}

function allTOrF(rows: QueryResult["rows"], col: number): boolean {
  let seen = false;
  for (const row of rows) {
    const v = row[col];
    if (v == null) continue;
    if (v !== "t" && v !== "f") return false;
    seen = true;
  }
  return seen;
}
