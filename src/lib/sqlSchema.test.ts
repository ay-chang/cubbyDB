import { describe, expect, it } from "vitest";

import {
  buildSqlNamespace,
  buildTableNamespace,
  columnOptions,
  parseTableRefs,
} from "./sqlSchema";
import type { ColumnNode, SchemaNode, TableNode } from "../types";

function col(name: string): ColumnNode {
  return {
    name,
    dataType: "text",
    nullable: true,
    isPrimaryKey: false,
    references: [],
    referencedBy: [],
  };
}

function table(name: string, columnNames: string[]): TableNode {
  return { name, kind: "table", estimatedRows: null, columns: columnNames.map(col) };
}

function schemaNode(name: string, tables: TableNode[]): SchemaNode {
  return { name, tables, functions: [], sequences: [], types: [] };
}

const schema: SchemaNode[] = [
  schemaNode("public", [
    table("users", ["id", "name", "email"]),
    table("recipes", ["id", "title", "user_id"]),
  ]),
  schemaNode("audit", [table("users", ["id", "changed_at"])]),
];

describe("buildSqlNamespace", () => {
  it("nests schema -> table -> column names", () => {
    expect(buildSqlNamespace(schema)).toEqual({
      public: { users: ["id", "name", "email"], recipes: ["id", "title", "user_id"] },
      audit: { users: ["id", "changed_at"] },
    });
  });

  it("returns an empty namespace for an empty schema", () => {
    expect(buildSqlNamespace([])).toEqual({});
  });
});

describe("buildTableNamespace", () => {
  it("scopes to exactly one table's columns, unwrapped", () => {
    expect(buildTableNamespace(schema, "public", "recipes")).toEqual({
      recipes: ["id", "title", "user_id"],
    });
  });

  it("distinguishes same-named tables in different schemas", () => {
    expect(buildTableNamespace(schema, "audit", "users")).toEqual({
      users: ["id", "changed_at"],
    });
  });

  it("returns an empty namespace for an unknown schema or table", () => {
    expect(buildTableNamespace(schema, "public", "no_such_table")).toEqual({});
    expect(buildTableNamespace(schema, "no_such_schema", "users")).toEqual({});
  });
});

describe("parseTableRefs", () => {
  it("parses an unaliased FROM, aliasing it to its own name", () => {
    expect(parseTableRefs("SELECT * FROM recipes")).toEqual([
      { schema: null, table: "recipes", alias: "recipes" },
    ]);
  });

  it("parses an explicit alias, with and without AS", () => {
    expect(parseTableRefs("SELECT * FROM recipes r")).toEqual([
      { schema: null, table: "recipes", alias: "r" },
    ]);
    expect(parseTableRefs("SELECT * FROM recipes AS r")).toEqual([
      { schema: null, table: "recipes", alias: "r" },
    ]);
  });

  it("does not mistake a following clause keyword for an alias", () => {
    // Without NOT_AN_ALIAS, "WHERE" would be read as recipes' alias.
    const refs = parseTableRefs("SELECT * FROM recipes WHERE id = 1");
    expect(refs).toEqual([{ schema: null, table: "recipes", alias: "recipes" }]);
  });

  it("parses a schema-qualified table", () => {
    expect(parseTableRefs("SELECT * FROM public.recipes")).toEqual([
      { schema: "public", table: "recipes", alias: "recipes" },
    ]);
  });

  it("strips double-quoting from a quoted identifier and its alias", () => {
    expect(parseTableRefs('SELECT * FROM "Public"."Recipes" AS "R"')).toEqual([
      { schema: "Public", table: "Recipes", alias: "R" },
    ]);
  });

  it("finds every JOIN as well as the FROM", () => {
    const refs = parseTableRefs(
      "SELECT * FROM recipes r JOIN users u ON u.id = r.user_id LEFT JOIN audit.users au ON au.id = u.id",
    );
    expect(refs).toEqual([
      { schema: null, table: "recipes", alias: "r" },
      { schema: null, table: "users", alias: "u" },
      { schema: "audit", table: "users", alias: "au" },
    ]);
  });

  it("recognizes UPDATE and INTO as table-introducing keywords too", () => {
    expect(parseTableRefs("UPDATE recipes SET title = 'x'")).toEqual([
      { schema: null, table: "recipes", alias: "recipes" },
    ]);
    expect(parseTableRefs("INSERT INTO recipes (title) VALUES ('x')")).toEqual([
      { schema: null, table: "recipes", alias: "recipes" },
    ]);
  });

  it("returns nothing for a statement with no table reference", () => {
    expect(parseTableRefs("SELECT 1")).toEqual([]);
  });
});

describe("columnOptions", () => {
  it("offers only the referenced table's columns, unqualified, when one table is in scope", () => {
    const opts = columnOptions(schema, "SELECT  FROM recipes", 7);
    expect(opts.map((o) => o.label).sort()).toEqual(["id", "title", "user_id"]);
    expect(opts.every((o) => o.detail === "recipes")).toBe(true);
  });

  it("labels a column with its alias when the table is aliased", () => {
    const opts = columnOptions(schema, "SELECT  FROM recipes r", 7);
    expect(opts.every((o) => o.detail === "r")).toBe(true);
  });

  it("de-duplicates a column shared by two joined tables", () => {
    const doc = "SELECT  FROM public.users pu JOIN audit.users au ON au.id = pu.id";
    const opts = columnOptions(schema, doc, 7);
    // "id" exists in both; every other option is unique per table.
    const ids = opts.filter((o) => o.label === "id");
    expect(ids).toHaveLength(1);
    expect(opts.map((o) => o.label).sort()).toEqual(["changed_at", "email", "id", "name"]);
  });

  it("falls back to every column in the schema, one entry per name, when no table is in scope yet", () => {
    // Writing the SELECT list before FROM exists — the common in-progress case.
    const opts = columnOptions(schema, "SELECT ", 7);
    const byLabel = new Map(opts.map((o) => [o.label, o]));
    // "id" is shared by three tables: public.users, public.recipes, and
    // audit.users — the last of which has the *same bare name* ("users") as
    // the first, from a different schema. Pins that they still count as
    // three distinct tables rather than collapsing to two.
    expect(byLabel.get("id")?.detail).toBe("3 tables");
    // "email" only lives on public.users.
    expect(byLabel.get("email")?.detail).toBe("users");
    expect(byLabel.size).toBe(6); // id, name, email, title, user_id, changed_at
  });

  it("only pulls columns from the statement under the cursor, not the whole script", () => {
    const doc = "SELECT  FROM recipes; SELECT  FROM users";
    // Cursor in the first statement should not see `users`' columns.
    const first = columnOptions(schema, doc, 7);
    expect(first.every((o) => o.detail === "recipes")).toBe(true);
  });
});
