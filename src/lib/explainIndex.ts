/**
 * Turns a `CREATE INDEX ...` definition (Postgres's own `pg_indexes.indexdef`
 * text, shown verbatim in the Table Structure pane) into a handful of plain-
 * English bullet points — deterministically, from the statement's own
 * grammar, not a guess. `pg_get_indexdef` always renders indexes in the same
 * canonical shape:
 *
 *   CREATE [UNIQUE] INDEX [CONCURRENTLY] name ON [ONLY] table
 *     USING method (col [opclass] [ASC|DESC] [NULLS FIRST|LAST], ...)
 *     [INCLUDE (col, ...)] [WITH (...)] [TABLESPACE ts] [WHERE (predicate)]
 *
 * so this is a small hand-rolled parser rather than a single regex — the
 * column/INCLUDE/WHERE clauses can themselves contain parens and commas
 * (expression indexes, function calls), which a regex can't safely bound.
 */

interface ParsedIndexDef {
  unique: boolean;
  method: string;
  columns: string[];
  include: string[];
  where: string | null;
}

const METHOD_EXPLANATIONS: Record<string, string> = {
  btree: "Uses a B-tree, the default and most common index type — supports " +
    "equality and range comparisons (=, <, >, BETWEEN) and sorting.",
  hash: "Uses a hash index — supports only equality lookups (=), not range " +
    "comparisons or sorting.",
  gin: "Uses GIN (Generalized Inverted Index) — suited to searching inside " +
    "composite values, such as full-text search, JSONB containment, or " +
    "array membership.",
  gist: "Uses GiST (Generalized Search Tree) — suited to geometric/range " +
    "types, full-text search, and nearest-neighbor queries.",
  spgist: "Uses SP-GiST (space-partitioned tree) — suited to data with a " +
    "natural spatial or hierarchical split, such as text prefixes or " +
    "geometric points.",
  brin: "Uses BRIN (Block Range Index) — very small and cheap to maintain, " +
    "best for a column that's naturally correlated with physical row order " +
    "(e.g. an ever-increasing timestamp); lookups are coarser than a B-tree.",
};

/** Index of `s`'s matching `)` for the `(` at `openIdx`, or -1 if unbalanced. */
function matchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on top-level commas only — depth-tracked so a comma inside a
 *  function call (e.g. `date_trunc('day', created_at)`) doesn't split it. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Parses one `CREATE INDEX` statement's shape. Returns `null` for anything
 *  that doesn't match the canonical `pg_get_indexdef` grammar this is built
 *  against — callers treat that as "can't explain this one," not an error. */
export function parseIndexDefinition(def: string): ParsedIndexDef | null {
  const head =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?\S+\s+ON\s+(?:ONLY\s+)?\S+\s+USING\s+(\w+)\s*/i.exec(
      def.trim(),
    );
  if (!head) return null;
  const unique = !!head[1];
  const method = head[2].toLowerCase();

  let rest = def.trim().slice(head[0].length);
  if (!rest.startsWith("(")) return null;
  const columnsEnd = matchingParen(rest, 0);
  if (columnsEnd === -1) return null;
  const columns = splitTopLevel(rest.slice(1, columnsEnd));
  rest = rest.slice(columnsEnd + 1).trim();

  let include: string[] = [];
  const includeHead = /^INCLUDE\s*\(/i.exec(rest);
  if (includeHead) {
    const openIdx = includeHead[0].length - 1;
    const closeIdx = matchingParen(rest, openIdx);
    if (closeIdx !== -1) {
      include = splitTopLevel(rest.slice(openIdx + 1, closeIdx));
      rest = rest.slice(closeIdx + 1).trim();
    }
  }

  // Storage params and tablespace affect maintenance, not query semantics —
  // skip over them without explaining, just to keep WHERE detection working.
  const withHead = /^WITH\s*\(/i.exec(rest);
  if (withHead) {
    const openIdx = withHead[0].length - 1;
    const closeIdx = matchingParen(rest, openIdx);
    if (closeIdx !== -1) rest = rest.slice(closeIdx + 1).trim();
  }
  const tablespaceHead = /^TABLESPACE\s+\S+\s*/i.exec(rest);
  if (tablespaceHead) rest = rest.slice(tablespaceHead[0].length).trim();

  let where: string | null = null;
  const whereHead = /^WHERE\s+(.*)$/is.exec(rest);
  if (whereHead) {
    where = whereHead[1].trim();
    // `pg_get_indexdef` wraps the predicate in one redundant paren pair —
    // strip it for a cleaner sentence if it's still there.
    if (where.startsWith("(") && matchingParen(where, 0) === where.length - 1) {
      where = where.slice(1, -1);
    }
  }

  return { unique, method, columns, include, where };
}

/** A plain column reference has no parens; anything else is a functional
 *  index term (e.g. `lower(email)`, `to_tsvector('english', body)`). */
function isExpression(column: string): boolean {
  return column.includes("(");
}

/** Strips the trailing `ASC|DESC [NULLS FIRST|LAST]`/opclass noise a column
 *  entry can carry, for display in a sentence. Best-effort: only strips the
 *  sort-direction/nulls keywords, since an opclass name can't be told apart
 *  from a legitimate trailing identifier without the catalog. */
function columnLabel(column: string): string {
  return column.replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?\s*$/i, "").trim();
}

function hasDesc(column: string): boolean {
  return /\bDESC\b/i.test(column);
}

/**
 * Explains one index definition as a list of plain-English bullet points, or
 * `null` if the definition doesn't match the grammar this parses (an
 * exotic/unsupported form) — callers should hide the "Explain" affordance
 * entirely in that case rather than show an empty or wrong explanation.
 */
export function explainIndexDefinition(def: string): string[] | null {
  const parsed = parseIndexDefinition(def);
  if (!parsed) return null;
  const { unique, method, columns, include, where } = parsed;
  if (columns.length === 0) return null;

  const lines: string[] = [];
  const labels = columns.map(columnLabel);

  if (unique) {
    lines.push(
      labels.length > 1
        ? `Enforces uniqueness — no two rows can share the same combination of ${labels.join(", ")}.`
        : `Enforces uniqueness — no two rows can share the same value of ${labels[0]}.`,
    );
  }

  lines.push(METHOD_EXPLANATIONS[method] ?? `Uses the "${method}" access method.`);

  const exprColumns = columns.filter(isExpression);
  if (exprColumns.length > 0) {
    lines.push(
      `Indexes the expression ${exprColumns.map(columnLabel).join(", ")} rather than a plain ` +
        "column — a query has to use that exact expression to benefit from this index.",
    );
  }

  const descColumns = columns.filter(hasDesc).map(columnLabel);
  if (descColumns.length > 0) {
    lines.push(`Sorted descending on ${descColumns.join(", ")}.`);
  }

  if (method === "btree" && columns.length > 1) {
    lines.push(
      `Composite index — column order matters: a query filtering on ${labels[0]} (optionally ` +
        "plus the columns after it, in order) can use this index; filtering on a later column " +
        "alone cannot.",
    );
  }

  if (include.length > 0) {
    lines.push(
      `Also stores ${include.join(", ")} alongside the index without making ${include.length > 1 ? "them" : "it"} ` +
        "part of the key, so some queries can be answered from the index alone.",
    );
  }

  if (where) {
    lines.push(`Partial index — only rows where ${where} are included.`);
  }

  return lines;
}
