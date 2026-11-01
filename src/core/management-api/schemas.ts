/**
 * Public schemas of the Postbox management API (v1).
 *
 * These describe the wire format external clients rely on. They are deliberately separate from the
 * route handlers' own validation so the contract only changes on purpose; tests/management-api.test.ts
 * sends contract examples to the real handlers and validates real responses against these schemas.
 */
import { z } from "zod";

const id = z.string().min(1).meta({ description: "Opaque identifier." });
const timestamp = z.number().int().meta({ description: "Unix time in milliseconds." });

export const errorSchema = z
  .object({
    error: z.string().meta({ description: "Human-readable message. Not stable; branch on the HTTP status." }),
    issues: z
      .array(
        z.looseObject({ path: z.array(z.union([z.string(), z.number()])).optional(), message: z.string() }),
      )
      .optional()
      .meta({ description: "Validation problems, present on 400 responses to invalid input." }),
  })
  .meta({ id: "Error" });

export const okSchema = z.object({ ok: z.literal(true) }).meta({ id: "Ok" });

export const healthSchema = z
  .object({
    status: z.literal("ok"),
    app: z.literal("postbox"),
    instance: z.string().optional(),
    time: z.string().meta({ format: "date-time" }),
  })
  .meta({ id: "Health" });

export const workspaceSchema = z
  .object({ id, name: z.string(), createdAt: timestamp, updatedAt: timestamp })
  .meta({ id: "Workspace" });

export const variableSchema = z
  .object({
    key: z.string(),
    value: z.string().default(""),
    type: z.enum(["default", "secret"]).default("default"),
    enabled: z.boolean().default(true),
  })
  .meta({ id: "Variable" });

export const keyValueSchema = z
  .looseObject({ key: z.string(), value: z.string(), enabled: z.boolean().optional() })
  .meta({ id: "KeyValue" });

export const folderSchema = z
  .looseObject({
    id,
    workspaceId: id,
    parentId: id.nullable().meta({ description: "Null for a collection (a top-level folder)." }),
    name: z.string(),
    description: z.string().optional(),
    headers: z.array(keyValueSchema),
    preRequestScript: z.string(),
    testScript: z.string(),
    variables: z
      .array(variableSchema)
      .optional()
      .meta({ description: "Collection variables (collections only)." }),
  })
  .meta({ id: "Folder" });

export const requestSchema = z
  .looseObject({
    id,
    name: z.string(),
    method: z.string(),
    url: z.string(),
    params: z.array(keyValueSchema),
    headers: z.array(keyValueSchema),
    preRequestScript: z.string(),
    testScript: z.string(),
  })
  .meta({
    id: "Request",
    description: "A saved request definition. Body, auth and settings are open objects.",
  });

/** Writable request fields. Anything omitted keeps its current value (PATCH) or default (POST). */
export const requestInputSchema = z
  .looseObject({
    name: z.string().min(1).optional(),
    method: z.string().optional(),
    url: z.string().optional(),
    params: z.array(keyValueSchema).optional(),
    headers: z.array(keyValueSchema).optional(),
    preRequestScript: z.string().optional(),
    testScript: z.string().optional(),
    description: z.string().optional(),
  })
  .meta({ id: "RequestInput" });

export const treeSchema = z
  .object({
    folders: z.array(z.object({ id, parentId: id.nullable(), name: z.string(), sort: z.number() })),
    requests: z.array(z.object({ id, folderId: id, name: z.string(), method: z.string(), sort: z.number() })),
  })
  .meta({ id: "Tree" });

export const environmentSummarySchema = z
  .looseObject({ id, workspaceId: id, name: z.string() })
  .meta({ id: "EnvironmentSummary" });

export const environmentSchema = z
  .looseObject({ id, name: z.string(), workspaceId: id, variables: z.array(variableSchema) })
  .meta({ id: "Environment" });

export const runOptionsSchema = z
  .object({
    iterations: z.number().int().min(0).max(100000).optional(),
    delayMs: z.number().int().min(0).max(600000).optional(),
    stopOnFailure: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).optional(),
    verifySsl: z.boolean().optional(),
    persistVariables: z.boolean().optional(),
  })
  .meta({ id: "RunOptions" });

export const runStatusSchema = z.enum(["queued", "running", "passed", "failed", "cancelled", "error"]);

export const runSchema = z
  .looseObject({
    id,
    workspaceId: id,
    folderId: id.nullable(),
    name: z.string(),
    status: runStatusSchema,
    iterations: z.number().int(),
    totalRequests: z.number().int(),
    totalTests: z.number().int(),
    passedTests: z.number().int(),
    failedTests: z.number().int(),
    durationMs: z.number(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: "Run" });

export const startRunSchema = z
  .object({
    workspaceId: id,
    folderId: id,
    environmentId: id.nullish(),
    options: runOptionsSchema.optional(),
    selectedRequestIds: z.array(id).nullish(),
  })
  .meta({ id: "StartRun" });

export const scheduleSchema = z
  .looseObject({
    id,
    workspaceId: id,
    folderId: id,
    name: z.string(),
    environmentId: id.nullable(),
    cron: z.string(),
    enabled: z.boolean(),
    lastRunAt: timestamp.nullable(),
    lastRunId: id.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: "Schedule" });

export const scheduleInputSchema = z
  .object({
    workspaceId: id,
    folderId: id,
    name: z.string().min(1).max(200),
    environmentId: id.nullish(),
    cron: z.string().max(200).meta({ description: "Five-field cron expression, evaluated in server time." }),
    options: runOptionsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .meta({ id: "ScheduleInput" });

export const webhookSchema = z
  .looseObject({
    id,
    workspaceId: id,
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    enabled: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
    pending: z.number().int().optional(),
  })
  .meta({ id: "Webhook", description: "A webhook as listed. The signing secret is never included." });

export const webhookWithSecretSchema = webhookSchema
  .extend({ secret: z.string().meta({ description: "Signing secret, shown only in this response." }) })
  .meta({ id: "WebhookWithSecret" });

export const webhookInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    url: z.string().max(2000),
    events: z.array(z.string()).min(1).max(20),
    enabled: z.boolean().optional(),
  })
  .meta({ id: "WebhookInput" });

export const settingsSchema = z
  .looseObject({
    values: z.record(z.string(), z.unknown()),
    saved: z.record(z.string(), z.unknown()),
    defaults: z.record(z.string(), z.unknown()),
    envLocked: z.array(z.string()).or(z.record(z.string(), z.unknown())),
  })
  .meta({ id: "Settings" });
