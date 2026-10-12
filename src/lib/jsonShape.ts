/** Shape questions about parsed JSON, for the cell inspector's structured
 *  view (`JsonView`): what's a container, how to summarize and label one,
 *  and when a list reads best as a table. */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object or array with at least one entry — what gets its own section. */
export function isNonEmptyContainer(value: unknown): value is JsonObject | unknown[] {
  if (Array.isArray(value)) return value.length > 0;
  return isJsonObject(value) && Object.keys(value).length > 0;
}

/** "3 fields" / "1 item" — the collapsed form of a container. */
export function summarize(value: JsonObject | unknown[]): string {
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  const noun = Array.isArray(value) ? "item" : "field";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Most columns a list-of-objects table gets before it's clearer as
 *  separate sections instead. */
const MAX_TABLE_COLUMNS = 8;

/** The columns to show a list as a table — the union of its objects' keys,
 *  in first-seen order — or `null` when it isn't a list of objects, or has
 *  too many distinct keys to read as one. */
export function tableColumns(list: unknown[]): string[] | null {
  if (list.length === 0) return null;
  const keys: string[] = [];
  for (const item of list) {
    if (!isJsonObject(item)) return null;
    for (const key of Object.keys(item)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys.length > 0 && keys.length <= MAX_TABLE_COLUMNS ? keys : null;
}

/** A JSON key as a readable label: `policyStartDate` → "Policy start date",
 *  `end_date` → "End date", `partnerID` → "Partner ID". Acronyms keep their
 *  capitals; everything else is lowercased after the first letter. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  if (words.length === 0) return key;
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

/** Follow a chain of single-field wrapper objects (`{ quoteContact: {
 *  person: { ... } } }`) down to the first level with real content, so it
 *  can show as one section — "Quote contact › Person" — instead of nesting
 *  a level per wrapper. Returns the keys passed through and that content. */
export function collapseChain(
  key: string,
  value: JsonObject | unknown[],
): { keys: string[]; value: JsonObject | unknown[] } {
  const keys = [key];
  let current = value;
  while (isJsonObject(current)) {
    const entries = Object.entries(current);
    if (entries.length !== 1) break;
    const [childKey, child] = entries[0];
    if (!isJsonObject(child) || Object.keys(child).length === 0) break;
    keys.push(childKey);
    current = child;
  }
  return { keys, value: current };
}
