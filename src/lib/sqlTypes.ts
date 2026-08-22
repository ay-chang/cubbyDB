/** Classifying a Postgres `format_type()` string for grid actions that only
 *  make sense on certain column types — kept separate from `sqlSchema.ts`
 *  (namespace/completion) since this is a different kind of question about a
 *  type: not "what can complete here" but "what does this column hold". */

/** Whether a column can reasonably hold a freshly generated UUID.
 *
 *  True for the `uuid` type itself, and for text-like types — `text`,
 *  `varchar`/`character varying`, `char`/`character`/`bpchar`, `citext` —
 *  since it's common (ORM defaults, a pre-native-uuid-type schema, a
 *  cross-database migration) to store a UUID as a string column instead of
 *  Postgres's own `uuid` type. Deliberately excludes everything else
 *  (`integer`, `boolean`, `jsonb`, ...): a random UUID isn't a value those
 *  types can hold, so offering the action there would just be a guaranteed
 *  error on commit.
 *
 *  `dataType` is `format_type()` output, so a parameterized type arrives as
 *  e.g. `character varying(255)` — matched by prefix, not equality. */
export function isUuidCapableType(dataType: string): boolean {
  const normalized = dataType.trim().toLowerCase();
  if (normalized === "uuid") return true;
  return UUID_CAPABLE_TEXT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

const UUID_CAPABLE_TEXT_PREFIXES = [
  "character varying",
  "varchar",
  "character",
  "char",
  "bpchar",
  "text",
  "citext",
];
