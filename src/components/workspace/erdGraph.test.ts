import { describe, expect, it } from "vitest";

import type { ColumnNode, SchemaNode, TableNode } from "../../types";
import { buildErdGraph, layoutErdGraph, visibleColumns } from "./erdGraph";

function col(overrides: Partial<ColumnNode> & { name: string }): ColumnNode {
  return {
    dataType: "text",
    nullable: true,
    isPrimaryKey: false,
    references: [],
    referencedBy: [],
    ...overrides,
  };
}

function table(overrides: Partial<TableNode> & { name: string }): TableNode {
  return {
    kind: "table",
    estimatedRows: null,
    columns: [],
    ...overrides,
  };
}

/** users <- orders <- order_items, plus an unrelated `tags` table and a
 *  cross-schema reference on `users`, reused across most tests below.
 *  `references`/`referencedBy` are mirrored on both sides of each FK, same
 *  as the real backend populates them (see `ColumnNode`'s own doc comment)
 *  — `buildErdGraph` relies on that invariant, same as the rest of the app
 *  already does (e.g. `TableStructurePane`'s "referenced by" badges). */
function buildSchema(): SchemaNode {
  return {
    name: "public",
    functions: [],
    sequences: [],
    types: [],
    tables: [
      table({
        name: "users",
        columns: [
          col({
            name: "id",
            isPrimaryKey: true,
            referencedBy: [{ schema: "public", table: "orders", column: "user_id" }],
          }),
          col({
            name: "org_id",
            references: [{ schema: "auth", table: "orgs", column: "id" }],
          }),
        ],
      }),
      table({
        name: "orders",
        columns: [
          col({
            name: "id",
            isPrimaryKey: true,
            referencedBy: [{ schema: "public", table: "order_items", column: "order_id" }],
          }),
          col({
            name: "user_id",
            references: [{ schema: "public", table: "users", column: "id" }],
          }),
        ],
      }),
      table({
        name: "order_items",
        columns: [
          col({ name: "id", isPrimaryKey: true }),
          col({
            name: "order_id",
            references: [{ schema: "public", table: "orders", column: "id" }],
          }),
        ],
      }),
      table({ name: "tags", columns: [col({ name: "id", isPrimaryKey: true })] }),
      table({ name: "order_summary", kind: "view", columns: [col({ name: "id" })] }),
    ],
  };
}

describe("buildErdGraph", () => {
  it("includes only the center table and its directly-connected tables, not the whole schema", () => {
    const { nodes } = buildErdGraph(buildSchema(), "orders");
    // orders -> users (outgoing), order_items -> orders (incoming); "tags"
    // and "order_summary" (a view) aren't connected to orders and must not
    // appear, which is the whole point of scoping per-table.
    expect(nodes.map((n) => n.id).sort()).toEqual(["order_items", "orders", "users"]);
  });

  it("marks exactly the center node as isCenter", () => {
    const { nodes } = buildErdGraph(buildSchema(), "orders");
    const center = nodes.find((n) => n.id === "orders")!;
    const others = nodes.filter((n) => n.id !== "orders");
    expect(center.data.isCenter).toBe(true);
    expect(others.every((n) => !n.data.isCenter)).toBe(true);
  });

  it("draws edges for every FK within the neighborhood, anchored by column handle", () => {
    const { edges } = buildErdGraph(buildSchema(), "orders");
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: "orders",
        sourceHandle: "orders.user_id",
        target: "users",
        targetHandle: "users.id",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: "order_items",
        sourceHandle: "order_items.order_id",
        target: "orders",
        targetHandle: "orders.id",
      }),
    );
  });

  it("counts the center's cross-schema references without drawing them", () => {
    const { crossSchemaRefCount } = buildErdGraph(buildSchema(), "users");
    // users.org_id -> auth.orgs is the center's own cross-schema reference.
    expect(crossSchemaRefCount).toBe(1);
  });

  it("does not count a neighbor's cross-schema references, only the center's", () => {
    // "users" is a neighbor of "orders" here (not the center) — users' own
    // cross-schema FK to "auth.orgs" must not leak into orders' count.
    const { crossSchemaRefCount } = buildErdGraph(buildSchema(), "orders");
    expect(crossSchemaRefCount).toBe(0);
  });

  it("returns an empty graph for a table that has no connections", () => {
    const { nodes, edges, crossSchemaRefCount } = buildErdGraph(buildSchema(), "tags");
    expect(nodes.map((n) => n.id)).toEqual(["tags"]);
    expect(edges).toHaveLength(0);
    expect(crossSchemaRefCount).toBe(0);
  });

  it("returns an empty graph for an unknown or non-table center", () => {
    expect(buildErdGraph(buildSchema(), "does_not_exist")).toEqual({
      nodes: [],
      edges: [],
      crossSchemaRefCount: 0,
    });
    expect(buildErdGraph(buildSchema(), "order_summary")).toEqual({
      nodes: [],
      edges: [],
      crossSchemaRefCount: 0,
    });
  });

  it("does not crash on a self-referencing foreign key", () => {
    const schema: SchemaNode = {
      name: "public",
      functions: [],
      sequences: [],
      types: [],
      tables: [
        table({
          name: "employees",
          columns: [
            col({ name: "id", isPrimaryKey: true }),
            col({
              name: "manager_id",
              references: [{ schema: "public", table: "employees", column: "id" }],
            }),
          ],
        }),
      ],
    };

    const { nodes, edges } = buildErdGraph(schema, "employees");
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("employees");
    expect(edges[0].target).toBe("employees");
  });
});

describe("layoutErdGraph", () => {
  it("assigns every node a finite position", () => {
    const { nodes, edges } = buildErdGraph(buildSchema(), "orders");
    const laidOut = layoutErdGraph(nodes, edges);

    expect(laidOut).toHaveLength(3);
    for (const node of laidOut) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });
});

describe("visibleColumns", () => {
  it("keeps only PK/FK-relevant columns, dropping plain data columns", () => {
    const t = table({
      name: "orders",
      columns: [
        col({ name: "id", isPrimaryKey: true }),
        col({
          name: "user_id",
          references: [{ schema: "public", table: "users", column: "id" }],
        }),
        col({ name: "note", isPrimaryKey: false }),
        col({ name: "total", isPrimaryKey: false }),
      ],
    });

    expect(visibleColumns(t).map((c) => c.name)).toEqual(["id", "user_id"]);
  });

  it("includes a column that's only an incoming FK target (referencedBy), not just outgoing", () => {
    const t = table({
      name: "users",
      columns: [
        col({
          name: "id",
          isPrimaryKey: true,
          referencedBy: [{ schema: "public", table: "orders", column: "user_id" }],
        }),
        col({ name: "email" }),
      ],
    });

    expect(visibleColumns(t).map((c) => c.name)).toEqual(["id"]);
  });

  it("falls back to the first few columns for a table with no PK/FK at all", () => {
    const t = table({
      name: "log_events",
      columns: [
        col({ name: "a" }),
        col({ name: "b" }),
        col({ name: "c" }),
        col({ name: "d" }),
        col({ name: "e" }),
      ],
    });

    expect(visibleColumns(t).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("returns every column when all of them are already PK/FK-relevant", () => {
    const t = table({
      name: "junction",
      columns: [
        col({
          name: "a_id",
          isPrimaryKey: true,
          references: [{ schema: "public", table: "a", column: "id" }],
        }),
        col({
          name: "b_id",
          isPrimaryKey: true,
          references: [{ schema: "public", table: "b", column: "id" }],
        }),
      ],
    });

    expect(visibleColumns(t)).toHaveLength(2);
  });
});
