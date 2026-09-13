import { describe, expect, it } from "vitest";

import { describeDestructiveRun, findDestructiveStatements } from "./destructiveSql";

const commands = (sql: string) => findDestructiveStatements(sql).map((s) => s.command);

describe("findDestructiveStatements", () => {
  it("flags row and object removal", () => {
    expect(commands("DELETE FROM public.orders WHERE id = 1")).toEqual(["DELETE"]);
    expect(commands("DROP TABLE public.users")).toEqual(["DROP"]);
    expect(commands("TRUNCATE public.audit_log")).toEqual(["TRUNCATE"]);
    expect(commands("DROP SCHEMA staging CASCADE")).toEqual(["DROP"]);
  });

  it("flags a dropped column or constraint, but not a dropped default", () => {
    expect(commands("ALTER TABLE public.users DROP COLUMN email")).toEqual(["DROP"]);
    expect(commands("ALTER TABLE public.users DROP CONSTRAINT users_pkey")).toEqual(["DROP"]);
    expect(commands("ALTER TABLE public.users ALTER COLUMN email DROP DEFAULT")).toEqual([]);
    expect(commands("ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL")).toEqual([]);
  });

  it("flags a data-modifying CTE that looks like a query", () => {
    expect(
      commands("WITH gone AS (DELETE FROM public.users RETURNING *) SELECT * FROM gone"),
    ).toEqual(["DELETE"]);
  });

  it("leaves ordinary statements alone", () => {
    expect(commands("SELECT * FROM public.users")).toEqual([]);
    expect(commands("UPDATE public.users SET admin = true WHERE id = 1")).toEqual([]);
    expect(commands("INSERT INTO public.users (name) VALUES ('Ada')")).toEqual([]);
    expect(commands("CREATE TABLE t (id int REFERENCES u(id) ON DELETE CASCADE)")).toEqual([]);
  });

  it("does not read a command out of a string, comment, or quoted identifier", () => {
    expect(commands("SELECT 'DELETE FROM users'")).toEqual([]);
    expect(commands("SELECT 1 -- DROP TABLE users")).toEqual([]);
    expect(commands("SELECT 1 /* TRUNCATE audit */")).toEqual([]);
    expect(commands('SELECT "drop" FROM public.words')).toEqual([]);
    expect(commands("SELECT $$DROP TABLE users$$")).toEqual([]);
  });

  it("finds every destructive statement in a multi-statement script", () => {
    const script = `
      SELECT count(*) FROM public.orders;
      DELETE FROM public.orders WHERE created_at < '2024-01-01';
      TRUNCATE public.audit_log;
    `;
    expect(commands(script)).toEqual(["DELETE", "TRUNCATE"]);
  });

  it("previews the statement on one line, including its WHERE clause", () => {
    const [found] = findDestructiveStatements(
      "DELETE FROM public.orders\n  WHERE created_at < '2024-01-01'",
    );
    expect(found.preview).toBe("DELETE FROM public.orders WHERE created_at < '2024-01-01'");
  });
});

describe("describeDestructiveRun", () => {
  it("names the single statement it is asking about", () => {
    const { message, statements } = describeDestructiveRun(
      findDestructiveStatements("DROP TABLE public.users"),
    );
    expect(message).toBe("This statement permanently removes data:");
    expect(statements).toEqual(["DROP TABLE public.users"]);
  });

  it("counts them, and leaves the question to the confirm button", () => {
    const script = "DROP TABLE a;\nTRUNCATE b;";
    const { message, statements } = describeDestructiveRun(findDestructiveStatements(script));
    expect(message).toBe("2 statements in this script permanently remove data:");
    expect(statements).toEqual(["DROP TABLE a", "TRUNCATE b"]);
  });

  it("lists a long script in full, for the dialog to collapse and scroll", () => {
    const script = Array.from({ length: 32 }, (_, i) => `DROP TABLE t${i};`).join("\n");
    const { message, statements } = describeDestructiveRun(findDestructiveStatements(script));
    expect(message).toContain("32 statements");
    expect(statements).toHaveLength(32);
  });

  it("caps a pathological script and summarizes the rest as a SQL comment", () => {
    const script = Array.from({ length: 62 }, (_, i) => `DROP TABLE t${i};`).join("\n");
    const { message, statements } = describeDestructiveRun(findDestructiveStatements(script));
    expect(message).toContain("62 statements");
    expect(statements).toHaveLength(51);
    expect(statements[50]).toBe("-- …and 12 more");
  });

  it("truncates a statement too long to be worth scrolling through", () => {
    const ids = Array.from({ length: 400 }, (_, i) => i).join(", ");
    const [found] = findDestructiveStatements(`DELETE FROM public.orders WHERE id IN (${ids})`);
    expect(found.preview).toHaveLength(160);
    expect(found.preview.endsWith("…")).toBe(true);
    expect(found.preview.startsWith("DELETE FROM public.orders WHERE id IN (0, 1,")).toBe(true);
  });
});
