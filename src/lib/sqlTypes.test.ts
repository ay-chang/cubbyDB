import { describe, expect, it } from "vitest";

import { isUuidCapableType } from "./sqlTypes";

describe("isUuidCapableType", () => {
  it("accepts the native uuid type", () => {
    expect(isUuidCapableType("uuid")).toBe(true);
    expect(isUuidCapableType("UUID")).toBe(true);
  });

  it("accepts text-like types, with or without a length modifier", () => {
    expect(isUuidCapableType("text")).toBe(true);
    expect(isUuidCapableType("character varying")).toBe(true);
    expect(isUuidCapableType("character varying(255)")).toBe(true);
    expect(isUuidCapableType("varchar(36)")).toBe(true);
    expect(isUuidCapableType("character(36)")).toBe(true);
    expect(isUuidCapableType("char(36)")).toBe(true);
    expect(isUuidCapableType("bpchar")).toBe(true);
    expect(isUuidCapableType("citext")).toBe(true);
  });

  it("rejects types a UUID string can't be stored in", () => {
    expect(isUuidCapableType("integer")).toBe(false);
    expect(isUuidCapableType("boolean")).toBe(false);
    expect(isUuidCapableType("jsonb")).toBe(false);
    expect(isUuidCapableType("timestamptz")).toBe(false);
    expect(isUuidCapableType("bytea")).toBe(false);
  });
});
