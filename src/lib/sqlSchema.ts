import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, schemaCompletionSource } from "@codemirror/lang-sql";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { LanguageSupport } from "@codemirror/language";

import { statementAt } from "./sqlStatements";
import type { SchemaNode } from "../types";

/**
 * Build a CodeMirror SQL-completion namespace (schema name -> table name ->
 * column names) from the app's own schema tree. Handed to `sqlLanguage()` so
 * the editor can offer schema-aware autocomplete: table names after
 * FROM/JOIN, and column names after `alias.` — resolved from the query's own
 * FROM/JOIN clauses by CodeMirror's built-in SQL completion, not by us.
 */
export function buildSqlNamespace(schema: SchemaNode[]): SQLNamespace {
  const namespace: Record<string, Record<string, string[]>> = {};
  for (const s of schema) {
    const tables: Record<string, string[]> = {};
    for (const t of s.tables) {
      tables[t.name] = t.columns.map((c) => c.name);
    }
    namespace[s.name] = tables;
  }
  return namespace;
}

/**
 * A namespace scoped to exactly one table's own columns — no schema
 * wrapper, no other tables. Used by the WHERE filter bar, which is always
 * scoped to a single already-known table and never needs table-name
 * completion (there's no FROM/JOIN in a bare predicate).
 *
 * This isn't just tidiness: `@codemirror/lang-sql`'s `completeFromSchema`
 * promotes *every table name in the default schema* into the top-level
 * bare-word completion list whenever a `defaultSchema` is supplied (so that
 * e.g. `sqlLanguage()`'s main-editor usage can suggest table names while
 * you're starting a FROM clause). Passing the WHERE bar the whole
 * multi-table `buildSqlNamespace(schema)` output — as this used to do —
 * means that promotion kicks in there too, even though the WHERE bar never
 * uses it: every bare-word keystroke ends up fuzzy-matched against every
 * table in the schema. Harmless for a handful of tables, but a genuine
 * perf cliff against a large production schema (hundreds/thousands of
 * tables) — each keystroke blocks the main thread scanning that whole
 * list. Scoping to just this table's columns keeps the candidate list
 * small regardless of how big the rest of the schema is.
 */
export function buildTableNamespace(
  schema: SchemaNode[],
  schemaName: string,
  tableName: string,
): SQLNamespace {
  const table = schema
    .find((s) => s.name === schemaName)
    ?.tables.find((t) => t.name === tableName);
  return table ? { [tableName]: table.columns.map((c) => c.name) } : {};
}

/** Keywords worth suggesting in a single-predicate WHERE clause — the small
 *  set of operators/connectives that actually show up there. */
export const WHERE_KEYWORDS = [
  "and", "or", "not", "is", "null", "in", "like", "ilike", "between", "exists",
  "true", "false",
];

/** A broader — but still curated — set of clause keywords for the main SQL
 *  editor, where writing a full statement needs more coverage than a single
 *  WHERE predicate does. */
export const SQL_KEYWORDS = [
  "select", "from", "where", "join", "left", "right", "inner", "outer",
  "full", "on", "as", "and", "or", "not", "in", "is", "null", "like",
  "ilike", "between", "exists", "group", "by", "having", "order", "asc",
  "desc", "limit", "offset", "distinct", "insert", "into", "values",
  "update", "set", "delete", "returning", "with", "union", "all", "case",
  "when", "then", "else", "end", "true", "false", "count", "sum", "avg",
  "min", "max",
];

/** A table named by the statement under the cursor, plus the identifier it's
 *  addressed by there (its alias, or its own name when unaliased). */
interface TableRef {
  schema: string | null;
  table: string;
  alias: string;
}

/**
 * Words that can directly follow a table reference but are never an alias —
 * without this, `FROM users WHERE ...` would read "WHERE" as the alias. Only
 * needs the words that can actually appear in that slot, not the full
 * keyword list.
 */
const NOT_AN_ALIAS = new Set([
  "where", "join", "inner", "left", "right", "full", "outer", "cross",
  "natural", "on", "using", "group", "order", "having", "limit", "offset",
  "fetch", "union", "intersect", "except", "set", "values", "returning",
  "select", "from", "into", "and", "or", "not", "window", "for", "lateral",
]);

/** `FROM`/`JOIN`/`UPDATE`/`INTO` followed by a (optionally schema-qualified,
 *  optionally quoted) table name and an optional `AS`-less alias. */
const TABLE_REF_RE =
  /\b(?:from|join|update|into)\s+("?[\w$]+"?(?:\.\s*"?[\w$]+"?)?)(?:\s+(?:as\s+)?("?[\w$]+"?))?/gi;

const unquote = (s: string) => s.replace(/^"|"$/g, "");

/** Table references in one statement's text, in source order. */
function parseTableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = [];
  TABLE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_REF_RE.exec(sql))) {
    const parts = m[1].split(".").map((p) => unquote(p.trim()));
    const schema = parts.length > 1 ? parts[0] : null;
    const table = parts.length > 1 ? parts[1] : parts[0];
    if (!table) continue;
    const rawAlias = m[2] ? unquote(m[2]) : null;
    const alias =
      rawAlias && !NOT_AN_ALIAS.has(rawAlias.toLowerCase()) ? rawAlias : table;
    refs.push({ schema, table, alias });
  }
  return refs;
}

/** The schema tree's entry for a parsed reference, matched case-insensitively
 *  (Postgres folds unquoted identifiers to lowercase) and, when the reference
 *  is unqualified, across every schema. */
function findTable(schema: SchemaNode[], ref: TableRef) {
  const wanted = ref.table.toLowerCase();
  for (const s of schema) {
    if (ref.schema && s.name.toLowerCase() !== ref.schema.toLowerCase()) continue;
    const t = s.tables.find((t) => t.name.toLowerCase() === wanted);
    if (t) return t;
  }
  return null;
}

/**
 * Bare (unqualified) column completions for the statement under the cursor.
 *
 * `@codemirror/lang-sql` only ever offers columns behind a qualifier — after
 * `alias.`/`table.`, or at the top level when a single `defaultTable` is
 * configured (which is how the WHERE bar gets them). In a real editor
 * statement there's no such single table, so typing a bare column name
 * matched nothing at all. This fills that gap: columns of whatever tables the
 * statement's own FROM/JOIN clauses name, offered unqualified.
 *
 * When the statement names no resolvable table yet — the very common case of
 * writing the SELECT list before the FROM clause — it falls back to every
 * column in the schema, collapsed to one entry per distinct name so a wide
 * schema's dozens of `id`/`created_at` columns don't flood the list.
 */
function columnOptions(schema: SchemaNode[], doc: string, pos: number): Completion[] {
  const stmt = statementAt(doc, pos);
  const text = stmt ? doc.slice(stmt.start, stmt.end) : doc;

  const inScope = parseTableRefs(text)
    .map((ref) => ({ ref, table: findTable(schema, ref) }))
    .filter((x): x is { ref: TableRef; table: NonNullable<ReturnType<typeof findTable>> } =>
      x.table !== null,
    );

  if (inScope.length > 0) {
    const out: Completion[] = [];
    const seen = new Set<string>();
    for (const { ref, table } of inScope) {
      for (const c of table.columns) {
        const key = c.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Above table names and keywords: inside a statement that already
        // names its tables, a bare word is far more often a column.
        out.push({ label: c.name, type: "property", detail: ref.alias, boost: 2 });
      }
    }
    return out;
  }

  // Fallback: no table in scope yet. One entry per distinct column name,
  // labelled with where it comes from.
  const byName = new Map<string, { name: string; tables: string[] }>();
  for (const s of schema) {
    for (const t of s.tables) {
      for (const c of t.columns) {
        const key = c.name.toLowerCase();
        const hit = byName.get(key);
        if (hit) {
          if (!hit.tables.includes(t.name)) hit.tables.push(t.name);
        } else {
          byName.set(key, { name: c.name, tables: [t.name] });
        }
      }
    }
  }
  return Array.from(byName.values()).map((c) => ({
    label: c.name,
    type: "property",
    detail: c.tables.length === 1 ? c.tables[0] : `${c.tables.length} tables`,
    // Below in-scope columns and table names — this is the speculative set.
    boost: -0.5,
  }));
}

/**
 * Postgres SQL language support with schema-aware completion, using a
 * curated keyword list instead of `@codemirror/lang-sql`'s bundled
 * `sql({...})` helper (which always registers its full dialect keyword
 * list alongside schema completion — several hundred words, including
 * obscure system-catalog and XML-function terms, that fuzzy-match so much
 * of what you type that they bury the schema suggestions that are actually
 * useful). Syntax highlighting is unaffected either way — that comes from
 * the parser/dialect itself, not from the completion source.
 *
 * Pass `schema` (the app's own tree) to additionally offer bare column names
 * from the statement's FROM/JOIN tables — see `columnOptions`. The WHERE bar
 * doesn't need it: `defaultTable` already covers its single-table case.
 */
export function sqlLanguage(
  namespace: SQLNamespace,
  defaultSchema: string | undefined,
  defaultTable: string | undefined,
  keywords: readonly string[],
  schema?: SchemaNode[],
): LanguageSupport {
  const schemaSource = schemaCompletionSource({
    dialect: PostgreSQL,
    schema: namespace,
    defaultSchema,
    defaultTable,
  });

  const source: CompletionSource = (context) => {
    // Match the case the user is typing, so a keyword completed mid-`SELECT`
    // comes out `SELECT` rather than lowercase. Identifiers (table/column
    // names) are deliberately left alone — their casing is the database's,
    // not a style choice.
    const typed = context.matchBefore(/[\w$]+/)?.text ?? "";
    const upper = /[A-Z]/.test(typed) && !/[a-z]/.test(typed);
    const keywordOptions: Completion[] = keywords.map((kw) => ({
      label: upper ? kw.toUpperCase() : kw,
      type: "keyword",
      boost: -1,
    }));

    const merge = (result: Awaited<ReturnType<CompletionSource>>) => {
      if (!result) return result;
      const extra: Completion[] = [...keywordOptions];
      // Only unqualified positions get bare column names; after a `.` the
      // schema source has already resolved the right table's columns and
      // anything we added would be wrong for that qualifier.
      if (schema && !/\.\s*[\w$]*$/.test(context.state.sliceDoc(0, context.pos))) {
        const existing = new Set(
          result.options.map((o) => o.label.toLowerCase()),
        );
        for (const c of columnOptions(schema, context.state.doc.toString(), context.pos)) {
          if (!existing.has(c.label.toLowerCase())) extra.push(c);
        }
      }
      return { ...result, options: [...result.options, ...extra] };
    };

    const result = schemaSource(context);
    return result instanceof Promise ? result.then(merge) : merge(result);
  };

  return new LanguageSupport(PostgreSQL.language, [
    PostgreSQL.language.data.of({ autocomplete: source }),
  ]);
}
