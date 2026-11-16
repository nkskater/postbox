import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { compactMcpSchema } from "@/server/mcp-schema";
import { MCP_TOOLSETS, parseMcpToolsets } from "@/lib/mcp-toolsets";
import { SETTINGS_BY_KEY, validateSetting } from "@/lib/settings/registry";

const ajv = () => new Ajv2020({ strict: false, validateFormats: false });

describe("MCP discovery schema compaction", () => {
  it("deduplicates schema nodes without turning properties maps or data into refs", () => {
    const row = {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "A sufficiently detailed repeated property used by this fixture to qualify for local schema reuse.",
        },
        value: { type: "string" },
      },
      required: ["key"],
      additionalProperties: false,
    };
    const schema = {
      type: "object",
      properties: { first: row, second: row, literal: { const: { properties: row, default: row } } },
      required: ["first", "second"],
    };
    const compact = compactMcpSchema(schema);
    expect(compact.$defs).toBeDefined();
    const validate = ajv().compile(compact);
    expect(
      validate({ first: { key: "a" }, second: { key: "b" }, literal: { properties: row, default: row } }),
    ).toBe(true);
    expect(validate({ first: { key: "a" }, second: { key: 7 } })).toBe(false);
    expect(compactMcpSchema({ const: { auth: row, body: row } })).toEqual({
      const: { auth: row, body: row },
    });
  });
  it("preserves tuple and dependency validation when using MCP's default 2020-12 dialect", () => {
    const compact = compactMcpSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        tuple: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false },
        a: { type: "string" },
        b: { type: "string" },
      },
      dependencies: { a: ["b"] },
    });
    expect(compact.$schema).toBeUndefined();
    const validate = ajv().compile(compact);
    expect(validate({ tuple: ["x", 1], a: "a", b: "b" })).toBe(true);
    expect(validate({ tuple: ["x", 1, 2] })).toBe(false);
    expect(validate({ tuple: [1] })).toBe(false);
    expect(validate({ a: "a" })).toBe(false);
  });
  it("does not collide with existing local definitions", () => {
    const row = {
      type: "string",
      minLength: 1,
      description:
        "A deliberately long repeated string schema with enough explanatory text to exceed the local definition reuse threshold used in the compact tool schema builder and exercise name collisions.",
    };
    const compact = compactMcpSchema({
      type: "object",
      $defs: { s0: { type: "number" } },
      properties: { a: row, b: row, c: { $ref: "#/$defs/s0" } },
    });
    const validate = ajv().compile(compact);
    expect(validate({ a: "x", b: "y", c: 1 })).toBe(true);
    expect(validate({ a: "x", b: "y", c: "bad" })).toBe(false);
  });
});

describe("MCP toolset selection", () => {
  it("canonicalizes selections and supports all", () => {
    expect(parseMcpToolsets(" mocks,core,mocks ")).toEqual(["core", "mocks"]);
    expect(parseMcpToolsets("all")).toEqual([...MCP_TOOLSETS]);
    expect(validateSetting(SETTINGS_BY_KEY.get("mcp.toolsets")!, "mocks,core")).toBe("core,mocks");
  });
  it("rejects empty, unknown, mixed-all and unbounded selections", () => {
    for (const invalid of ["", "unknown", "all,core", "core,", "core,".repeat(100)]) {
      expect(() => parseMcpToolsets(invalid)).toThrow(/MCP toolsets/);
      expect(() => validateSetting(SETTINGS_BY_KEY.get("mcp.toolsets")!, invalid)).toThrow();
    }
  });
});
