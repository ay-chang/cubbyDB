import { describe, expect, it } from "vitest";

import { splitStatements, statementAt } from "./sqlStatements";

const slice = (sql: string, r: { start: number; end: number }) => sql.slice(r.start, r.end);

describe("splitStatements", () => {
  it("splits a plain multi-statement script on top-level semicolons", () => {
    const sql = "SELECT 1; SELECT 2; SELECT 3";
    const ranges = splitStatements(sql);
    expect(ranges.map((r) => slice(sql, r))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("returns one range for a script with no semicolon", () => {
    const sql = "SELECT * FROM t";
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual(["SELECT * FROM t"]);
  });

  it("drops empty statements (trailing semicolon, blank lines between)", () => {
    const sql = "SELECT 1;\n\n;  \nSELECT 2;";
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("returns nothing for an all-whitespace script", () => {
    expect(splitStatements("   \n  \n")).toEqual([]);
  });

  it("ignores a semicolon inside a single-quoted string", () => {
    const sql = "SELECT 'a;b' AS x; SELECT 2";
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual([
      "SELECT 'a;b' AS x",
      "SELECT 2",
    ]);
  });

  it("handles an escaped quote ('') inside a string without ending it early", () => {
    const sql = "SELECT 'it''s; still one string' AS x; SELECT 2";
    const ranges = splitStatements(sql);
    expect(ranges).toHaveLength(2);
    expect(slice(sql, ranges[0])).toBe("SELECT 'it''s; still one string' AS x");
  });

  it("ignores a semicolon inside a double-quoted identifier", () => {
    const sql = 'SELECT 1 AS "weird;name"; SELECT 2';
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual([
      'SELECT 1 AS "weird;name"',
      "SELECT 2",
    ]);
  });

  it("ignores a semicolon inside a line comment", () => {
    // The comment isn't stripped, only recognized so its `;` doesn't end the
    // statement early — the pushed range still carries it verbatim, which is
    // what lets "run the statement under the cursor" reproduce the source
    // exactly rather than a paraphrase of it.
    const sql = "SELECT 1 -- a comment; with a semicolon\n; SELECT 2";
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual([
      "SELECT 1 -- a comment; with a semicolon",
      "SELECT 2",
    ]);
  });

  it("ignores a semicolon inside a block comment", () => {
    const sql = "SELECT 1 /* a; comment */; SELECT 2";
    expect(splitStatements(sql).map((r) => slice(sql, r))).toEqual([
      "SELECT 1 /* a; comment */",
      "SELECT 2",
    ]);
  });

  it("trims each returned range to the trimmed statement text", () => {
    const sql = "  SELECT 1  ;  \n  SELECT 2  ";
    const ranges = splitStatements(sql);
    expect(ranges.map((r) => slice(sql, r))).toEqual(["SELECT 1", "SELECT 2"]);
    // The range itself is tight, not just the slice — a caller highlighting
    // `[start, end)` shouldn't include the surrounding whitespace.
    expect(sql[ranges[0].start]).toBe("S");
    expect(sql[ranges[0].end - 1]).toBe("1");
  });
});

describe("statementAt", () => {
  const sql = "SELECT 1;\nSELECT 2;\nSELECT 3";
  // Ranges: "SELECT 1" [0,8), "SELECT 2" [10,18), "SELECT 3" [20,28)

  it("returns null for a script with no statements", () => {
    expect(statementAt("   ", 0)).toBeNull();
  });

  it("finds the statement containing a cursor position inside it", () => {
    const r = statementAt(sql, 3); // inside "SELECT 1"
    expect(r && slice(sql, r)).toBe("SELECT 1");
  });

  it("returns the next statement when the cursor sits in the gap between two", () => {
    // Position 9 is the semicolon/newline gap right after "SELECT 1;".
    const r = statementAt(sql, 9);
    expect(r && slice(sql, r)).toBe("SELECT 2");
  });

  it("returns the last statement when the cursor is past the end", () => {
    const r = statementAt(sql, 999);
    expect(r && slice(sql, r)).toBe("SELECT 3");
  });

  it("returns the first statement when the cursor is at position 0", () => {
    const r = statementAt(sql, 0);
    expect(r && slice(sql, r)).toBe("SELECT 1");
  });
});
