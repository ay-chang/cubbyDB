import { describe, expect, it } from "vitest";

import type { QueryResult } from "../types";
import { normalizeBooleanText } from "./booleanText";

function result(
  columns: Array<{ name: string; dataType?: string }>,
  rows: Array<Array<string | null>>,
): QueryResult {
  return {
    columns: columns.map((c) => ({ name: c.name, dataType: c.dataType ?? null })),
    rows,
    rowCount: rows.length,
    elapsedMs: 0,
    commandTag: null,
    limitApplied: false,
    paged: false,
  };
}

describe("normalizeBooleanText", () => {
  it("spells out an inferred boolean column and leaves NULLs and other columns alone", () => {
    const r = result([{ name: "ok" }, { name: "note" }], [
      ["t", "t"],
      [null, "x"],
      ["f", "f"],
    ]);
    expect(normalizeBooleanText(r).rows).toEqual([
      ["true", "t"],
      [null, "x"],
      ["false", "f"],
    ]);
  });

  it("trusts a reported type over the values", () => {
    const r = result([{ name: "flag", dataType: "text" }, { name: "b", dataType: "bool" }], [
      ["t", null],
    ]);
    expect(normalizeBooleanText(r).rows).toEqual([["t", null]]);
  });

  it("returns the same result when there is nothing to rewrite", () => {
    const r = result([{ name: "n" }], [[null], ["1"]]);
    expect(normalizeBooleanText(r)).toBe(r);
  });
});
