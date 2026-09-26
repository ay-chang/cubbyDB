import { describe, expect, it } from "vitest";

import { explainIndexDefinition, parseIndexDefinition } from "./explainIndex";

describe("parseIndexDefinition", () => {
  it("parses a plain unique btree index", () => {
    expect(
      parseIndexDefinition("CREATE UNIQUE INDEX recipes_pkey ON public.recipes USING btree (id)"),
    ).toEqual({
      unique: true,
      method: "btree",
      columns: ["id"],
      include: [],
      where: null,
    });
  });

  it("parses a composite index with a descending column", () => {
    expect(
      parseIndexDefinition(
        "CREATE INDEX idx_orders_customer_date ON public.orders USING btree (customer_id, created_at DESC)",
      ),
    ).toEqual({
      unique: false,
      method: "btree",
      columns: ["customer_id", "created_at DESC"],
      include: [],
      where: null,
    });
  });

  it("parses a partial index and strips the redundant WHERE parens", () => {
    const parsed = parseIndexDefinition(
      "CREATE UNIQUE INDEX idx_active_email ON public.users USING btree (email) WHERE (deleted_at IS NULL)",
    );
    expect(parsed?.where).toBe("deleted_at IS NULL");
  });

  it("keeps a functional index's expression intact despite its own parens", () => {
    const parsed = parseIndexDefinition(
      "CREATE INDEX idx_lower_email ON public.users USING btree (lower(email::text))",
    );
    expect(parsed?.columns).toEqual(["lower(email::text)"]);
  });

  it("splits GIN's function-call column without breaking on the inner comma", () => {
    const parsed = parseIndexDefinition(
      "CREATE INDEX idx_search ON public.articles USING gin (to_tsvector('english'::regconfig, body))",
    );
    expect(parsed?.method).toBe("gin");
    expect(parsed?.columns).toEqual(["to_tsvector('english'::regconfig, body)"]);
  });

  it("parses INCLUDE columns separately from the key columns", () => {
    const parsed = parseIndexDefinition(
      "CREATE UNIQUE INDEX idx_covering ON public.t USING btree (a) INCLUDE (b, c)",
    );
    expect(parsed?.columns).toEqual(["a"]);
    expect(parsed?.include).toEqual(["b", "c"]);
  });

  it("returns null for a statement that isn't a CREATE INDEX", () => {
    expect(parseIndexDefinition("ALTER TABLE public.t ADD COLUMN x int")).toBeNull();
  });
});

describe("explainIndexDefinition", () => {
  it("explains a plain primary-key index", () => {
    const lines = explainIndexDefinition(
      "CREATE UNIQUE INDEX recipes_pkey ON public.recipes USING btree (id)",
    );
    expect(lines).not.toBeNull();
    expect(lines!.join(" ")).toMatch(/uniqueness.*id/i);
    expect(lines!.join(" ")).toMatch(/B-tree/);
  });

  it("calls out the leftmost-prefix rule for a composite btree index", () => {
    const lines = explainIndexDefinition(
      "CREATE INDEX idx ON public.orders USING btree (customer_id, created_at)",
    );
    expect(lines!.some((l) => l.includes("Composite index"))).toBe(true);
  });

  it("does not mention composite-index ordering for a single-column index", () => {
    const lines = explainIndexDefinition("CREATE INDEX idx ON public.t USING btree (a)");
    expect(lines!.some((l) => l.includes("Composite index"))).toBe(false);
  });

  it("calls out a partial index's WHERE clause", () => {
    const lines = explainIndexDefinition(
      "CREATE INDEX idx ON public.users USING btree (email) WHERE (deleted_at IS NULL)",
    );
    expect(lines!.some((l) => l.includes("Partial index"))).toBe(true);
  });

  it("calls out a functional/expression index", () => {
    const lines = explainIndexDefinition(
      "CREATE INDEX idx ON public.users USING btree (lower(email))",
    );
    expect(lines!.some((l) => l.includes("expression"))).toBe(true);
  });

  it("calls out INCLUDE (covering) columns", () => {
    const lines = explainIndexDefinition(
      "CREATE UNIQUE INDEX idx ON public.t USING btree (a) INCLUDE (b, c)",
    );
    expect(lines!.some((l) => l.includes("Also stores b, c"))).toBe(true);
  });

  it("explains GIN's use case", () => {
    const lines = explainIndexDefinition(
      "CREATE INDEX idx ON public.articles USING gin (to_tsvector('english', body))",
    );
    expect(lines!.join(" ")).toMatch(/full-text search/);
  });

  it("explains hash's equality-only limitation", () => {
    const lines = explainIndexDefinition("CREATE INDEX idx ON public.t USING hash (a)");
    expect(lines!.join(" ")).toMatch(/only equality/);
  });

  it("returns null for an unparseable definition", () => {
    expect(explainIndexDefinition("not a create index statement")).toBeNull();
  });
});
