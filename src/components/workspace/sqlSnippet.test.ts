import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { highlightSql } from "./sqlSnippet";

/** Flattens `highlightSql`'s output back to plain text — the property every
 *  case below leans on is that this always reconstructs the input exactly;
 *  highlighting must never drop, reorder, or duplicate a character. */
function flatten(nodes: ReactNode): string {
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  return arr
    .map((n) => {
      if (typeof n === "string") return n;
      if (isValidElement(n)) return String((n.props as { children?: ReactNode }).children ?? "");
      return "";
    })
    .join("");
}

/** The sequence of (class, text) pairs `highlightSql` actually produced —
 *  `null` class for a plain (unstyled) run. */
function tokens(nodes: ReactNode): Array<[string | null, string]> {
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  return arr.map((n) => {
    if (typeof n === "string") return [null, n];
    if (isValidElement(n)) {
      const props = n.props as { className: string; children: string };
      return [props.className, props.children];
    }
    return [null, ""];
  });
}

const cases = [
  "",
  "no sql content here",
  "SELECT count(*) FROM public.users WHERE name ILIKE 'bob%' LIMIT 10;",
  "-- a comment with SELECT inside\nSELECT 1.5 FROM t /* block SELECT */ WHERE x = 'it''s'",
  `SELECT "select" FROM "weird table" WHERE a=1`,
  "SELECT * FROM t WHERE s = 'unterminated",
  "the selection process",
];

describe("highlightSql: text is always reconstructed exactly", () => {
  it.each(cases)("round-trips %j", (code) => {
    expect(flatten(highlightSql(code))).toBe(code);
  });
});

describe("highlightSql: token classification", () => {
  it("colors a keyword, leaving its original case intact", () => {
    expect(tokens(highlightSql("SELECT"))).toEqual([["md-sql--keyword", "SELECT"]]);
    expect(tokens(highlightSql("select"))).toEqual([["md-sql--keyword", "select"]]);
  });

  it("does not color a word that merely contains a keyword as a substring", () => {
    // "selection" must not be read as SELECT — tokens are whole identifiers,
    // matched against the keyword set as a whole word, not a substring scan.
    expect(tokens(highlightSql("selection"))).toEqual([[null, "selection"]]);
  });

  it("colors a line comment, and does not color a keyword inside it", () => {
    const t = tokens(highlightSql("-- SELECT this"));
    expect(t).toEqual([["md-sql--comment", "-- SELECT this"]]);
  });

  it("colors a block comment, and does not color a keyword inside it", () => {
    const t = tokens(highlightSql("/* SELECT this */"));
    expect(t).toEqual([["md-sql--comment", "/* SELECT this */"]]);
  });

  it("colors a single-quoted string, and does not color a keyword inside it", () => {
    expect(tokens(highlightSql("'SELECT this'"))).toEqual([["md-sql--string", "'SELECT this'"]]);
  });

  it("keeps a doubled '' escape inside the same string token", () => {
    expect(tokens(highlightSql("'it''s'"))).toEqual([["md-sql--string", "'it''s'"]]);
  });

  it("recognizes a double-quoted identifier as one token, but leaves it unstyled", () => {
    // Quoted identifiers aren't strings in Postgres — and if this weren't
    // tokenized as a unit, "select" inside the quotes would get colored as
    // the keyword despite being a column name here.
    const t = tokens(highlightSql('"select"'));
    expect(t).toEqual([[null, '"select"']]);
  });

  it("colors an integer and a decimal number", () => {
    expect(tokens(highlightSql("42"))).toEqual([["md-sql--number", "42"]]);
    expect(tokens(highlightSql("1.5"))).toEqual([["md-sql--number", "1.5"]]);
  });

  it("does not color an identifier that merely starts with digits differently, or an identifier with a trailing digit as a number", () => {
    expect(tokens(highlightSql("amount1"))).toEqual([[null, "amount1"]]);
  });

  it("classifies a realistic mixed statement, keywords only", () => {
    // Unhighlighted text (the gaps, and "id"/"t" — neither is in
    // SQL_KEYWORDS) is pushed as separate plain segments rather than merged
    // into one run; that segmentation is an implementation detail, not part
    // of the contract, so this checks only which substrings got colored.
    const styled = tokens(highlightSql("SELECT id FROM t")).filter(([cls]) => cls);
    expect(styled).toEqual([
      ["md-sql--keyword", "SELECT"],
      ["md-sql--keyword", "FROM"],
    ]);
  });

  it("passes non-SQL text through with nothing colored", () => {
    const t = tokens(highlightSql("no sql content here"));
    expect(t.every(([cls]) => cls === null)).toBe(true);
  });

  it("returns an empty array for an empty string", () => {
    expect(highlightSql("")).toEqual([]);
  });
});
