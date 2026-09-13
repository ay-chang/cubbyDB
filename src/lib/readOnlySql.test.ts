import { describe, expect, it } from "vitest";

import { isReadOnlySql } from "./readOnlySql";

/** Mirrors the Rust cases in `src-tauri/src/db/read_only.rs` — the two gates
 *  are meant to agree, and these are the cases that catch them drifting. */
describe("isReadOnlySql", () => {
  it("accepts the SELECT family", () => {
    for (const sql of [
      "SELECT * FROM public.users LIMIT 10",
      "WITH recent AS (SELECT * FROM events) SELECT * FROM recent;",
      "VALUES (1), (2)",
      "TABLE public.users",
      "SHOW server_version",
      "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.users",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it("does not read command words out of quoted content or comments", () => {
    for (const sql of [
      "SELECT 'DELETE FROM users'",
      'SELECT "update" FROM public.words',
      "SELECT $$DROP TABLE users$$",
      "SELECT 1 /* DELETE; nested /* UPDATE */ safe */; -- INSERT",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it("rejects writes, DDL, and data-modifying CTEs", () => {
    for (const sql of [
      "INSERT INTO users(name) VALUES ('Ada')",
      "UPDATE users SET admin = true",
      "DELETE FROM users",
      "DROP TABLE users",
      "WITH removed AS (DELETE FROM users RETURNING *) SELECT * FROM removed",
      "SELECT * INTO archived_users FROM users",
      "EXPLAIN ANALYZE UPDATE users SET admin = true",
      "BEGIN; UPDATE users SET admin = true WHERE id = 1; ROLLBACK;",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });

  it("rejects multiple statements and non-query prefixes", () => {
    for (const sql of ["SELECT 1; SELECT 2", "SELECT 1;;", "SELECT 1; 2", "", "SET search_path = public"]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });
});
