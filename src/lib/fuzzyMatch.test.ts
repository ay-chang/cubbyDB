import { describe, expect, it } from "vitest";

import { bestMatch, fuzzyMatch } from "./fuzzyMatch";

describe("fuzzyMatch", () => {
  it("returns a zero-score empty match for an empty query", () => {
    expect(fuzzyMatch("", "recipes")).toEqual({ score: 0, indices: [] });
  });

  it("prefers a contiguous substring match, with indices covering it", () => {
    const m = fuzzyMatch("rec", "recipes");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2]);
  });

  it("matches case-insensitively but reports indices into the original casing", () => {
    const m = fuzzyMatch("REC", "Recipes");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2]);
  });

  it("falls back to an in-order subsequence when there's no contiguous run", () => {
    // "rps" in order inside "recipes": r(0) e c i p(4) e s(6)
    const m = fuzzyMatch("rps", "recipes");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 4, 6]);
  });

  it("returns null when the query's characters aren't all present in order", () => {
    expect(fuzzyMatch("xyz", "recipes")).toBeNull();
    // Present, but in the wrong order — "pr" never appears in that order.
    expect(fuzzyMatch("pr", "recipes")).toBeNull();
  });

  it("scores an earlier substring match higher than a later one", () => {
    const early = fuzzyMatch("cat", "cat_food");
    const late = fuzzyMatch("cat", "the_cat");
    expect(early!.score).toBeGreaterThan(late!.score);
  });

  it("scores a contiguous run higher than a scattered subsequence of the same length", () => {
    // "abc" is a run in "abcxxx" but scattered across "axbxcx".
    const contiguous = fuzzyMatch("abc", "abcxxx");
    const scattered = fuzzyMatch("abc", "axbxcx");
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });
});

describe("bestMatch", () => {
  it("returns null when no candidate matches", () => {
    expect(bestMatch("zzz", ["recipes", "users"])).toBeNull();
  });

  it("picks the highest-scoring candidate and reports its index", () => {
    // Both are substring matches, but candidate 1 wins on both factors that
    // raise a substring match's score: an earlier position (index 0 vs. 13)
    // and a shorter overall target — even though candidate 0 is checked first.
    const m = bestMatch("rec", ["public.other_recipes", "recipes"]);
    expect(m).not.toBeNull();
    expect(m!.candidate).toBe(1);
  });

  it("carries the winning candidate's match shape through", () => {
    const m = bestMatch("rec", ["recipes"]);
    expect(m).toEqual({ score: expect.any(Number), indices: [0, 1, 2], candidate: 0 });
  });
});
