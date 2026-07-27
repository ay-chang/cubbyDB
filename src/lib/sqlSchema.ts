import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, schemaCompletionSource } from "@codemirror/lang-sql";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { LanguageSupport } from "@codemirror/language";

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

/**
 * Postgres SQL language support with schema-aware completion, using a
 * curated keyword list instead of `@codemirror/lang-sql`'s bundled
 * `sql({...})` helper (which always registers its full dialect keyword
 * list alongside schema completion — several hundred words, including
 * obscure system-catalog and XML-function terms, that fuzzy-match so much
 * of what you type that they bury the schema suggestions that are actually
 * useful). Syntax highlighting is unaffected either way — that comes from
 * the parser/dialect itself, not from the completion source.
 */
export function sqlLanguage(
  namespace: SQLNamespace,
  defaultSchema: string | undefined,
  defaultTable: string | undefined,
  keywords: readonly string[],
): LanguageSupport {
  const schemaSource = schemaCompletionSource({
    dialect: PostgreSQL,
    schema: namespace,
    defaultSchema,
    defaultTable,
  });
  const keywordOptions: Completion[] = keywords.map((label) => ({
    label,
    type: "keyword",
    boost: -1,
  }));
  const merge = (result: Awaited<ReturnType<CompletionSource>>) =>
    result ? { ...result, options: [...result.options, ...keywordOptions] } : result;
  const source: CompletionSource = (context) => {
    const result = schemaSource(context);
    return result instanceof Promise ? result.then(merge) : merge(result);
  };
  return new LanguageSupport(PostgreSQL.language, [
    PostgreSQL.language.data.of({ autocomplete: source }),
  ]);
}
