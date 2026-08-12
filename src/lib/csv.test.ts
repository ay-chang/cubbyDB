import { describe, expect, it } from "vitest";

import { parseCsv, toCsv } from "./csv";

describe("toCsv / parseCsv round-trip", () => {
  it("preserves accented text, embedded quotes, delimiters, newlines, and null", () => {
    const rows = [
      ["title", "difficulty", "note"],
      ["Pâté au poulet en pâte à croissant", "Easy", "accented"],
      ['He said "hi"', "Easy", "quote"],
      ["a,b", "Easy", "delimiter"],
      ["multi\nline", "Easy", "newline"],
      ["nullcell", null, "null"],
    ];
    const back = parseCsv(toCsv(rows, ","), ",");
    expect(back).toEqual(rows.map((r) => r.map((v) => v ?? "")));
  });

  it("round-trips with a tab delimiter, since csvDelimiter is user-configurable", () => {
    const rows = [
      ["a", "b"],
      ["1", "2\t3"],
    ];
    const back = parseCsv(toCsv(rows, "\t"), "\t");
    expect(back).toEqual(rows);
  });

  it("strips a leading BOM on import", () => {
    // `saveCsv` writes a BOM so Excel reads UTF-8 correctly; without this
    // stripping, the marker rides along on the first header name and stops
    // that column matching on re-import.
    const rows = [["id", "name"], ["1", "a"]];
    const withBom = "﻿" + toCsv(rows, ",");
    expect(parseCsv(withBom, ",")[0][0]).toBe("id");
  });
});

describe("parseCsv edge cases", () => {
  it("handles a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops a single trailing blank row from a final newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles \\r\\n line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles an empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
