import { describe, it, expect } from "vitest";
import { governanceConfig, DEFAULT_GOVERNANCE, effectiveGovernanceConfig } from "@/core/governance/model";
import { lintGovernance, governanceGlob } from "@/core/governance/lint";
import type { SpecificationSource } from "@/core/specifications/model";
const source = (
  content: string,
  files: SpecificationSource["files"] = [],
  format: SpecificationSource["format"] = "openapi",
): SpecificationSource => ({
  format,
  entrypoint: "api.yaml",
  files: [{ path: "api.yaml", content }, ...files],
});
const healthy =
  'openapi: 3.0.3\ninfo: {title: Pets, version: "1", description: Pets API}\nservers:\n  - url: https://example.test\nsecurity: [{bearer: []}]\ncomponents:\n  securitySchemes:\n    bearer: {type: http, scheme: bearer}\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      summary: List pets\n      responses:\n        "200": {description: OK}\n';
const rules = (rule: Record<string, unknown>) =>
  governanceConfig.parse({
    formatVersion: 1,
    name: "Custom",
    rules: [{ id: "custom", message: "Custom policy failed", ...rule }],
  });
describe("bounded declarative governance", () => {
  it("passes default API style and security rules with deterministic hashes and output", () => {
    const first = lintGovernance(source(healthy), DEFAULT_GOVERNANCE);
    expect(first.diagnostics).toEqual([]);
    expect(first.complete).toBe(true);
    expect(first.summary.evaluated).toBeGreaterThan(5);
    expect(lintGovernance(source(healthy), DEFAULT_GOVERNANCE)).toEqual(first);
  });
  it("locates naming, missing summaries and insecure server diagnostics without echoing values", () => {
    const input = healthy
      .replace("https://example.test", "http://example.test?token=secret-value")
      .replace("/pets:", "/Bad_Pets:")
      .replace("      summary: List pets\n", "");
    const report = lintGovernance(source(input), DEFAULT_GOVERNANCE);
    expect(report.diagnostics.map((d) => d.ruleId)).toEqual(
      expect.arrayContaining(["secure-servers", "path-kebab-case", "operation-summary"]),
    );
    expect(report.diagnostics.find((d) => d.ruleId === "secure-servers")).toMatchObject({
      file: "api.yaml",
      line: 4,
      path: "/servers/0",
    });
    expect(report.diagnostics.find((d) => d.ruleId === "path-kebab-case")?.path).toBe("/paths/~1Bad_Pets");
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });
  it("honors severity overrides and justified file/pointer exclusions", () => {
    const input = source(healthy.replace("https://example.test", "http://example.test"));
    const config = effectiveGovernanceConfig(DEFAULT_GOVERNANCE, { "secure-servers": "warning" });
    expect(lintGovernance(input, config).summary).toMatchObject({ errors: 0, warnings: 1 });
    const excluded = effectiveGovernanceConfig(config, {}, [
      { ruleId: "secure-servers", file: "api.*", path: "/servers/**", reason: "Local fixture" },
    ]);
    expect(lintGovernance(input, excluded).summary).toMatchObject({ errors: 0, warnings: 0, excluded: 1 });
    expect(
      lintGovernance(input, effectiveGovernanceConfig(config, { "secure-servers": "off" })).summary.disabled,
    ).toBe(1);
  });
  it("requires effective security, including rejecting an optional empty alternative", () => {
    const report = lintGovernance(
      source(healthy.replace("security: [{bearer: []}]", "security: [{bearer: []}, {}]")),
      DEFAULT_GOVERNANCE,
    );
    expect(report.diagnostics.some((d) => d.ruleId === "operation-security")).toBe(true);
  });
  it("checks inherited security and follows supplied operation references with their actual locations", () => {
    const root =
      'openapi: 3.0.3\ninfo: {title: API, version: "1", description: API}\nsecurity: [{bearer: []}]\npaths:\n  /pets:\n    $ref: "parts.yaml#/pets"';
    const report = lintGovernance(
      source(root, [
        {
          path: "parts.yaml",
          content:
            'pets:\n  get:\n    operationId: listPets\n    responses:\n      "200": {description: OK}\n',
        },
      ]),
      DEFAULT_GOVERNANCE,
    );
    expect(report.diagnostics.find((d) => d.ruleId === "operation-summary")).toMatchObject({
      file: "parts.yaml",
      line: 3,
      path: "/pets/get/summary",
    });
    expect(report.diagnostics.some((d) => d.ruleId === "operation-security")).toBe(false);
  });
  it("finds duplicate operation IDs across operations", () => {
    const text =
      healthy +
      '  /more:\n    get:\n      operationId: listPets\n      summary: More pets\n      responses:\n        "200": {description: OK}\n';
    const report = lintGovernance(source(text), DEFAULT_GOVERNANCE);
    expect(report.diagnostics.filter((d) => d.ruleId === "operation-id-unique")).toHaveLength(1);
  });
  it("supports custom field checks, safe wildcard matching and missing required fields", () => {
    const config = rules({
      given: "/info",
      field: "/contact/email",
      severity: "error",
      check: { kind: "required" },
    });
    expect(lintGovernance(source(healthy), config).summary.errors).toBe(1);
    const naming = rules({
      scope: "operations",
      given: "/*",
      field: "/operationId",
      check: { kind: "matches", value: "list*" },
    });
    expect(lintGovernance(source(healthy), naming).diagnostics).toEqual([]);
    expect(governanceGlob("a*?z", "abcz")).toBe(true);
    expect(governanceGlob("a?z", "az")).toBe(false);
    expect(governanceGlob("📬.yaml", "📬.yaml")).toBe(true);
  });
  it("supports symbol checks for non-JSON specification formats", () => {
    const config = rules({
      formats: ["graphql"],
      scope: "symbols",
      given: "/*",
      field: "/name",
      check: { kind: "casing", value: "pascal" },
    });
    const report = lintGovernance(
      source("type Query { pet: bad_pet }\ntype bad_pet { name: String }", [], "graphql"),
      config,
    );
    expect(report.diagnostics.find((d) => d.ruleId === "custom")).toMatchObject({ line: 2 });
  });
  it("rejects duplicate IDs, unknown overrides, invalid selectors, executable/regex checks and exclusions without reason", () => {
    const base = {
      formatVersion: 1,
      name: "Invalid",
      rules: [{ id: "custom", message: "x", check: { kind: "required" } }],
    };
    for (const data of [
      { ...base, rules: [...base.rules, ...base.rules] },
      { ...base, overrides: { missing: "off" } },
      { ...base, rules: [{ ...base.rules[0], given: "$.paths" }] },
      { ...base, rules: [{ ...base.rules[0], check: { kind: "regex", value: "(a+)+$" } }] },
      { ...base, exclusions: [{ ruleId: "*", file: "*", path: "/**", reason: "" }] },
    ])
      expect(governanceConfig.safeParse(data).success).toBe(false);
  });
  it("never allows syntax failures to be suppressed by governance overrides or exclusions", () => {
    const config = governanceConfig.parse({
      formatVersion: 1,
      name: "No rules",
      rules: [],
      exclusions: [{ ruleId: "*", file: "*", path: "/**", reason: "Everything" }],
    });
    const report = lintGovernance(source("openapi: [broken"), config);
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.diagnostics[0].ruleId).toMatch(/^syntax-/);
  });
  it("bounds match work and marks incomplete reports instead of returning a clean result", () => {
    const config = rules({ given: "/**/**/**/**/**", check: { kind: "required" } });
    const large = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: {},
      components: {
        schemas: Object.fromEntries(
          Array.from({ length: 8000 }, (_, i) => [
            "Item" + i,
            { type: "object", properties: { name: { type: "string" } } },
          ]),
        ),
      },
    };
    const report = lintGovernance(source(JSON.stringify(large)), config);
    expect(report.complete).toBe(false);
    expect(report.diagnostics.some((d) => d.ruleId === "governance-limit")).toBe(true);
  });
});

describe("governance security consistency and formats", () => {
  it("does not treat malformed explicit operation security as inherited authentication", () => {
    const text = healthy.replace(
      "      summary: List pets",
      "      security: null\n      summary: List pets",
    );
    expect(
      lintGovernance(source(text), DEFAULT_GOVERNANCE).diagnostics.some(
        (d) => d.ruleId === "operation-security",
      ),
    ).toBe(true);
  });
  it("rejects undefined security scheme names even when authentication is declared", () => {
    const report = lintGovernance(
      source(healthy.replace("security: [{bearer: []}]", "security: [{unknown: []}]")),
      DEFAULT_GOVERNANCE,
    );
    expect(report.diagnostics.some((d) => d.ruleId === "defined-security-schemes")).toBe(true);
    expect(report.diagnostics.some((d) => d.ruleId === "operation-security")).toBe(false);
  });
  it("evaluates AsyncAPI 3 operation names and secure transport declarations", () => {
    const input =
      'asyncapi: 3.0.0\ninfo: {title: Events, version: "1", description: Events API}\nservers:\n  main: {host: events.example.test, protocol: mqtts}\nchannels:\n  events: {address: events}\noperations:\n  receiveEvents:\n    action: receive\n    summary: Receive events\n    channel: {$ref: "#/channels/events"}';
    expect(lintGovernance(source(input, [], "asyncapi"), DEFAULT_GOVERNANCE).diagnostics).toEqual([]);
    expect(
      lintGovernance(
        source(input.replace("protocol: mqtts", "protocol: mqtt"), [], "asyncapi"),
        DEFAULT_GOVERNANCE,
      ).diagnostics.some((d) => d.ruleId === "secure-servers"),
    ).toBe(true);
  });
});
