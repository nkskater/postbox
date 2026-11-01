import { describe, expect, it } from "vitest";
import {
  PACKAGE_LIMITS,
  packageContentSchema,
  packageCreateSchema,
  packagePatchSchema,
  packageRevisionSchema,
  packageNameSchema,
} from "@/core/packages/model";

const validName = "a".repeat(63);

describe("packageNameSchema", () => {
  const valid = validName;
  it("accepts a minimal valid input", () => {
    expect(packageNameSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects name one past the length limit", () => {
    expect(packageNameSchema.safeParse("a".repeat(64)).success).toBe(false);
  });
});

describe("packageContentSchema", () => {
  const valid = { source: "x", approved: false };
  it("accepts a minimal valid input", () => {
    expect(packageContentSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects missing source", () => {
    const { source: _source, ...rest } = valid;
    expect(packageContentSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts source at the length limit and rejects one past it", () => {
    expect(
      packageContentSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes) }).success,
    ).toBe(true);
    expect(
      packageContentSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes + 1) })
        .success,
    ).toBe(false);
  });
});

describe("packageCreateSchema", () => {
  const valid = { name: validName, description: "", source: "x", approved: false };
  it("accepts a minimal valid input", () => {
    expect(packageCreateSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects missing name", () => {
    const { name: _name, ...rest } = valid;
    expect(packageCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing source", () => {
    const { source: _source, ...rest } = valid;
    expect(packageCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts name at the length limit and rejects one past it", () => {
    expect(packageCreateSchema.safeParse({ ...valid, name: "a".repeat(63) }).success).toBe(true);
    expect(packageCreateSchema.safeParse({ ...valid, name: "a".repeat(64) }).success).toBe(false);
  });
  it("accepts description at the length limit and rejects one past it", () => {
    expect(packageCreateSchema.safeParse({ ...valid, description: "a".repeat(10000) }).success).toBe(true);
    expect(packageCreateSchema.safeParse({ ...valid, description: "a".repeat(10001) }).success).toBe(false);
  });
  it("accepts source at the length limit and rejects one past it", () => {
    expect(
      packageCreateSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes) }).success,
    ).toBe(true);
    expect(
      packageCreateSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes + 1) }).success,
    ).toBe(false);
  });
});

describe("packageRevisionSchema", () => {
  const valid = { expectedVersion: 1, source: "x", approved: false };
  it("accepts a minimal valid input", () => {
    expect(packageRevisionSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects missing expectedVersion", () => {
    const { expectedVersion: _expectedVersion, ...rest } = valid;
    expect(packageRevisionSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing source", () => {
    const { source: _source, ...rest } = valid;
    expect(packageRevisionSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts expectedVersion at the boundary and rejects one past it", () => {
    expect(packageRevisionSchema.safeParse({ ...valid, expectedVersion: 1 }).success).toBe(true);
    expect(packageRevisionSchema.safeParse({ ...valid, expectedVersion: 0 }).success).toBe(false);
  });
  it("accepts source at the length limit and rejects one past it", () => {
    expect(
      packageRevisionSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes) }).success,
    ).toBe(true);
    expect(
      packageRevisionSchema.safeParse({ ...valid, source: "a".repeat(PACKAGE_LIMITS.sourceBytes + 1) })
        .success,
    ).toBe(false);
  });
});

describe("packagePatchSchema", () => {
  const valid = { description: "" };
  it("accepts a minimal valid input", () => {
    expect(packagePatchSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects missing description", () => {
    expect(packagePatchSchema.safeParse({}).success).toBe(false);
  });
  it("accepts description at the length limit and rejects one past it", () => {
    expect(packagePatchSchema.safeParse({ ...valid, description: "a".repeat(10000) }).success).toBe(true);
    expect(packagePatchSchema.safeParse({ ...valid, description: "a".repeat(10001) }).success).toBe(false);
  });
});

describe("package name format and byte limits", () => {
  it("rejects names that are not lowercase, start with a digit or use other characters", () => {
    for (const name of ["Abc", "1abc", "a_b", "-abc", ""])
      expect(packageNameSchema.safeParse(name).success).toBe(false);
    expect(packageNameSchema.safeParse("my-pkg2").success).toBe(true);
  });
  it("rejects content whose UTF-8 size exceeds the limit even when the string length fits", () => {
    const source = "é".repeat(PACKAGE_LIMITS.sourceBytes / 2 + 1);
    expect(source.length).toBeLessThanOrEqual(PACKAGE_LIMITS.sourceBytes);
    expect(packageContentSchema.safeParse({ source }).success).toBe(false);
    expect(
      packageContentSchema.safeParse({ source: "é".repeat(PACKAGE_LIMITS.sourceBytes / 2) }).success,
    ).toBe(true);
  });
});
