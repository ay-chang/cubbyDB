import { describe, expect, it } from "vitest";

import {
  collapseChain,
  humanizeKey,
  isJsonObject,
  isNonEmptyContainer,
  summarize,
  tableColumns,
} from "./jsonShape";

describe("isJsonObject / isNonEmptyContainer", () => {
  it("tells objects from arrays and null", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([1])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  it("only counts containers with entries", () => {
    expect(isNonEmptyContainer({ a: 1 })).toBe(true);
    expect(isNonEmptyContainer([0])).toBe(true);
    expect(isNonEmptyContainer({})).toBe(false);
    expect(isNonEmptyContainer([])).toBe(false);
    expect(isNonEmptyContainer("x")).toBe(false);
  });
});

describe("summarize", () => {
  it("counts fields and items, singular and plural", () => {
    expect(summarize({ a: 1, b: 2 })).toBe("2 fields");
    expect(summarize({ a: 1 })).toBe("1 field");
    expect(summarize([1])).toBe("1 item");
  });
});

describe("tableColumns", () => {
  it("unions the keys of a list of objects in first-seen order", () => {
    expect(tableColumns([{ id: 1, name: "a" }, { id: 2, email: "b" }])).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("rejects lists that aren't all objects, are empty, or are too wide", () => {
    expect(tableColumns([{ id: 1 }, 2])).toBeNull();
    expect(tableColumns([])).toBeNull();
    expect(tableColumns([{}])).toBeNull();
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    expect(tableColumns([wide])).toBeNull();
  });
});

describe("humanizeKey", () => {
  it("splits camelCase, snake_case, and kebab-case into a sentence", () => {
    expect(humanizeKey("policyStartDate")).toBe("Policy start date");
    expect(humanizeKey("end_date")).toBe("End date");
    expect(humanizeKey("mailing-address")).toBe("Mailing address");
  });

  it("keeps acronyms and separates digits", () => {
    expect(humanizeKey("partnerID")).toBe("Partner ID");
    expect(humanizeKey("HTTPStatus")).toBe("HTTP status");
    expect(humanizeKey("address2")).toBe("Address 2");
  });

  it("leaves keys it can't split alone, capitalized", () => {
    expect(humanizeKey("name")).toBe("Name");
    expect(humanizeKey("_")).toBe("_");
  });
});

describe("collapseChain", () => {
  it("passes through single-field wrapper objects", () => {
    const person = { first: "A", last: "B" };
    expect(collapseChain("quoteContact", { person })).toEqual({
      keys: ["quoteContact", "person"],
      value: person,
    });
  });

  it("stops at a level with several fields, a scalar, or a list", () => {
    const two = { a: 1, b: 2 };
    expect(collapseChain("k", two)).toEqual({ keys: ["k"], value: two });
    expect(collapseChain("k", { only: 5 })).toEqual({ keys: ["k"], value: { only: 5 } });
    expect(collapseChain("k", { items: [1, 2] })).toEqual({
      keys: ["k"],
      value: { items: [1, 2] },
    });
  });
});
