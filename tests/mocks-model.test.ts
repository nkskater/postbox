import { describe, expect, it } from "vitest";
import { mockSettingsSchema, mockCreateSchema, mockPatchSchema } from "@/core/mocks/model";

const valid = {
  name: "ok",
  enabled: true,
  public: false,
  matchQuery: true,
  matchBody: true,
  delayMs: 0,
  status: null,
  headers: [],
  scenarios: [],
};

describe("mockSettingsSchema", () => {
  it("accepts a minimal valid input", () => {
    expect(mockSettingsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a missing name", () => {
    const { name: _name, ...rest } = valid;
    expect(mockSettingsSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts name at the length limit and rejects one past it", () => {
    expect(mockSettingsSchema.safeParse({ ...valid, name: "a".repeat(200) }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, name: "a".repeat(201) }).success).toBe(false);
  });
  it("accepts delayMs at the min and rejects one below", () => {
    expect(mockSettingsSchema.safeParse({ ...valid, delayMs: 0 }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, delayMs: -1 }).success).toBe(false);
  });
  it("accepts delayMs at the max and rejects one above", () => {
    expect(mockSettingsSchema.safeParse({ ...valid, delayMs: 30000 }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, delayMs: 30001 }).success).toBe(false);
  });
  it("accepts status at the min and rejects one below", () => {
    expect(mockSettingsSchema.safeParse({ ...valid, status: 200 }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, status: 199 }).success).toBe(false);
  });
  it("accepts status at the max and rejects one above", () => {
    expect(mockSettingsSchema.safeParse({ ...valid, status: 599 }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, status: 600 }).success).toBe(false);
  });
  it("accepts headers at the max length and rejects one past", () => {
    const header = { key: "k", value: "v", enabled: true };
    expect(mockSettingsSchema.safeParse({ ...valid, headers: Array(100).fill(header) }).success).toBe(true);
    expect(mockSettingsSchema.safeParse({ ...valid, headers: Array(101).fill(header) }).success).toBe(false);
  });
});

describe("mockCreateSchema", () => {
  const validCreate = { ...valid, workspaceId: "w", folderId: "f" };
  it("accepts a minimal valid input", () => {
    expect(mockCreateSchema.safeParse(validCreate).success).toBe(true);
  });
  it("rejects a missing name", () => {
    const { name: _name, ...rest } = validCreate;
    expect(mockCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects a missing workspaceId", () => {
    const { workspaceId: _workspaceId, ...rest } = validCreate;
    expect(mockCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects a missing folderId", () => {
    const { folderId: _folderId, ...rest } = validCreate;
    expect(mockCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts name at the length limit and rejects one past it", () => {
    expect(mockCreateSchema.safeParse({ ...validCreate, name: "a".repeat(200) }).success).toBe(true);
    expect(mockCreateSchema.safeParse({ ...validCreate, name: "a".repeat(201) }).success).toBe(false);
  });
  it("accepts workspaceId at the min and rejects one below", () => {
    expect(mockCreateSchema.safeParse({ ...validCreate, workspaceId: "w" }).success).toBe(true);
    expect(mockCreateSchema.safeParse({ ...validCreate, workspaceId: "" }).success).toBe(false);
  });
  it("accepts folderId at the min and rejects one below", () => {
    expect(mockCreateSchema.safeParse({ ...validCreate, folderId: "f" }).success).toBe(true);
    expect(mockCreateSchema.safeParse({ ...validCreate, folderId: "" }).success).toBe(false);
  });
});

describe("mockPatchSchema", () => {
  it("accepts a minimal valid input (empty object)", () => {
    expect(mockPatchSchema.safeParse({}).success).toBe(true);
  });
  it("accepts name at the length limit and rejects one past it", () => {
    expect(mockPatchSchema.safeParse({ name: "a".repeat(200) }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
  });
  it("accepts delayMs at the min and rejects one below", () => {
    expect(mockPatchSchema.safeParse({ delayMs: 0 }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ delayMs: -1 }).success).toBe(false);
  });
  it("accepts delayMs at the max and rejects one above", () => {
    expect(mockPatchSchema.safeParse({ delayMs: 30000 }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ delayMs: 30001 }).success).toBe(false);
  });
  it("accepts status at the min and rejects one below", () => {
    expect(mockPatchSchema.safeParse({ status: 200 }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ status: 199 }).success).toBe(false);
  });
  it("accepts status at the max and rejects one above", () => {
    expect(mockPatchSchema.safeParse({ status: 599 }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ status: 600 }).success).toBe(false);
  });
  it("accepts headers at the max length and rejects one past", () => {
    const header = { key: "k", value: "v", enabled: true };
    expect(mockPatchSchema.safeParse({ headers: Array(100).fill(header) }).success).toBe(true);
    expect(mockPatchSchema.safeParse({ headers: Array(101).fill(header) }).success).toBe(false);
  });
});

describe("mock name trimming", () => {
  it("rejects a whitespace-only name and trims surrounding spaces", () => {
    expect(mockPatchSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(mockPatchSchema.parse({ name: "  api  " }).name).toBe("api");
  });
});
