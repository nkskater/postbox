import { z } from "zod";
import { specificationFormat, type SourceLocation } from "../specifications/model";
export const GOVERNANCE_LIMITS = {
  rules: 100,
  exclusions: 200,
  bytes: 128 * 1024,
  diagnostics: 500,
  evaluations: 50000,
  work: 5000000,
  reports: 50,
  sets: 50,
  versions: 100,
} as const;
export const severity = z.enum(["error", "warning", "info", "off"]);
export type GovernanceSeverity = z.infer<typeof severity>;
const pointer = z
  .string()
  .max(1000)
  .refine((s) => s === "" || s.startsWith("/"), "Use an empty root pointer or a /-prefixed JSON pointer")
  .refine((s) => s.split("/").length <= 32 && !/~(?![01])/g.test(s), "Invalid pointer escape or depth");
const primitive = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const governanceCheck = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum([
        "required",
        "forbidden",
        "nonEmpty",
        "unique",
        "https",
        "security",
        "securityReferences",
        "pathKebab",
      ]),
    })
    .strict(),
  z
    .object({ kind: z.literal("type"), value: z.enum(["string", "number", "boolean", "object", "array"]) })
    .strict(),
  z
    .object({ kind: z.literal("casing"), value: z.enum(["camel", "pascal", "snake", "kebab", "lower"]) })
    .strict(),
  z.object({ kind: z.enum(["equals", "notEquals"]), value: primitive }).strict(),
  z.object({ kind: z.literal("oneOf"), values: z.array(primitive).min(1).max(100) }).strict(),
  z
    .object({
      kind: z.enum(["startsWith", "endsWith", "contains", "matches"]),
      value: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal("minLength"), value: z.number().int().min(1).max(10000) }).strict(),
]);
export const governanceRule = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,79}$/)
      .refine(
        (id) => !id.startsWith("syntax-") && !id.startsWith("governance-"),
        "System diagnostic prefixes are reserved",
      ),
    message: z.string().trim().min(1).max(500),
    description: z.string().max(2000).default(""),
    severity: severity.default("warning"),
    formats: z.array(specificationFormat).min(1).max(5).default(["openapi", "asyncapi"]),
    scope: z
      .enum(["document", "operations", "paths", "servers", "symbols", "references"])
      .default("document"),
    given: pointer.default(""),
    field: pointer
      .refine(
        (s) => !s.split("/").includes("*") && !s.split("/").includes("**"),
        "Field must be an exact relative pointer",
      )
      .default(""),
    target: z.enum(["value", "key"]).default("value"),
    files: z.enum(["entrypoint", "all"]).default("entrypoint"),
    check: governanceCheck,
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.target === "key" && rule.field)
      ctx.addIssue({ code: "custom", message: "Key checks cannot select a field" });
  });
export const governanceExclusion = z
  .object({
    ruleId: z.string().max(80).default("*"),
    file: z.string().min(1).max(200).default("*"),
    path: pointer.default("/**"),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const governanceOverrides = z.record(z.string().max(80), severity);
export const governanceConfig = z
  .object({
    formatVersion: z.literal(1),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    rules: z.array(governanceRule).max(GOVERNANCE_LIMITS.rules),
    overrides: governanceOverrides.default({}),
    exclusions: z.array(governanceExclusion).max(GOVERNANCE_LIMITS.exclusions).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = config.rules.map((r) => r.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Rule IDs must be unique" });
    for (const id of Object.keys(config.overrides))
      if (!ids.includes(id))
        ctx.addIssue({ code: "custom", message: `Override refers to unknown rule ${id}` });
    for (const item of config.exclusions)
      if (item.ruleId !== "*" && !ids.includes(item.ruleId))
        ctx.addIssue({ code: "custom", message: `Exclusion refers to unknown rule ${item.ruleId}` });
    if (new TextEncoder().encode(JSON.stringify(config)).length > GOVERNANCE_LIMITS.bytes)
      ctx.addIssue({ code: "custom", message: "Rule set exceeds 128 KiB" });
  });
export type GovernanceConfig = z.infer<typeof governanceConfig>;
export type GovernanceRule = z.infer<typeof governanceRule>;
export type GovernanceExclusion = z.infer<typeof governanceExclusion>;
export interface GovernanceDiagnostic extends SourceLocation {
  ruleId: string;
  severity: Exclude<GovernanceSeverity, "off">;
  message: string;
  path: string;
}
export interface GovernanceReport {
  reportVersion: 1;
  sourceHash: string;
  rulesHash: string;
  complete: boolean;
  diagnostics: GovernanceDiagnostic[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    evaluated: number;
    excluded: number;
    disabled: number;
    notApplicable: number;
  };
}
export function effectiveGovernanceConfig(
  config: GovernanceConfig,
  overrides: Record<string, GovernanceSeverity> = {},
  exclusions: GovernanceExclusion[] = [],
) {
  return governanceConfig.parse({
    ...config,
    overrides: { ...config.overrides, ...overrides },
    exclusions: [...config.exclusions, ...exclusions],
  });
}
export const DEFAULT_GOVERNANCE = governanceConfig.parse({
  formatVersion: 1,
  name: "API style and security",
  rules: [
    {
      id: "api-description",
      message: "Describe the API in info.description",
      given: "",
      field: "/info/description",
      check: { kind: "nonEmpty" },
    },
    {
      id: "operation-summary",
      message: "Give every operation a summary",
      scope: "operations",
      given: "/*",
      field: "/summary",
      check: { kind: "nonEmpty" },
    },
    {
      id: "operation-id",
      message: "Give every operation an operationId",
      severity: "error",
      scope: "operations",
      given: "/*",
      field: "/operationId",
      check: { kind: "nonEmpty" },
    },
    {
      id: "operation-id-camel-case",
      message: "Use camelCase operation IDs",
      scope: "operations",
      given: "/*",
      field: "/operationId",
      check: { kind: "casing", value: "camel" },
    },
    {
      id: "operation-id-unique",
      message: "Operation IDs must be unique",
      severity: "error",
      scope: "operations",
      given: "/*",
      field: "/operationId",
      check: { kind: "unique" },
    },
    {
      id: "path-kebab-case",
      message: "Use lowercase kebab-case path segments",
      formats: ["openapi"],
      scope: "paths",
      given: "/*",
      target: "key",
      check: { kind: "pathKebab" },
    },
    {
      id: "secure-servers",
      message: "Servers must declare an encrypted protocol",
      severity: "error",
      scope: "servers",
      given: "/*",
      check: { kind: "https" },
    },
    {
      id: "defined-security-schemes",
      message: "Security requirements must reference declared security schemes",
      severity: "error",
      formats: ["openapi"],
      scope: "operations",
      given: "/*",
      field: "/security",
      check: { kind: "securityReferences" },
    },
    {
      id: "operation-security",
      message: "Declare effective authentication or exclude the intentionally public operation",
      severity: "error",
      formats: ["openapi"],
      scope: "operations",
      given: "/*",
      field: "/security",
      check: { kind: "security" },
    },
  ],
});
