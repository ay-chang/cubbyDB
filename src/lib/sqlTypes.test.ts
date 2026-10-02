import { describe, expect, it } from "vitest";

import { isUuidCapableType, shortTypeName } from "./sqlTypes";

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

describe("shortTypeName", () => {
  it("maps SQL-standard spellings to Postgres's internal names", () => {
    expect(shortTypeName("integer")).toBe("int4");
    expect(shortTypeName("double precision")).toBe("float8");
    expect(shortTypeName("boolean")).toBe("bool");
  });

  it("keeps modifiers and array suffixes", () => {
    expect(shortTypeName("character varying(255)")).toBe("varchar(255)");
    expect(shortTypeName("numeric(10,2)")).toBe("numeric(10,2)");
    expect(shortTypeName("bigint[]")).toBe("int8[]");
  });

  it("folds the time-zone forms into timestamp/timestamptz", () => {
    expect(shortTypeName("timestamp without time zone")).toBe("timestamp");
    expect(shortTypeName("timestamp(3) without time zone")).toBe("timestamp(3)");
    expect(shortTypeName("timestamp with time zone")).toBe("timestamptz");
    expect(shortTypeName("time with time zone")).toBe("timetz");
  });

  it("leaves other names alone, minus identifier quotes", () => {
    expect(shortTypeName("text")).toBe("text");
    expect(shortTypeName("jsonb")).toBe("jsonb");
    expect(shortTypeName('"UserRole"')).toBe("UserRole");
  });
});
