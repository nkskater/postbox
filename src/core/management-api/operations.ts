/**
 * The v1 management API operation registry. Each entry is one documented route; the OpenAPI document
 * is generated from it and tests tie every entry to its access policy and to the real handler.
 */
import { z, type ZodType } from "zod";
import {
  environmentSchema,
  environmentSummarySchema,
  errorSchema,
  folderSchema,
  healthSchema,
  okSchema,
  requestInputSchema,
  requestSchema,
  runSchema,
  scheduleInputSchema,
  scheduleSchema,
  settingsSchema,
  startRunSchema,
  treeSchema,
  variableSchema,
  webhookInputSchema,
  webhookSchema,
  webhookWithSecretSchema,
  workspaceSchema,
} from "./schemas";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** What the caller must hold. "read"…"manage" are workspace actions; the rest are account-level. */
export type Access = "public" | "account" | "admin" | "read" | "run" | "write" | "manage";

export interface QueryParam {
  schema: ZodType;
  required?: boolean;
  description?: string;
}

export interface Operation {
  id: string;
  method: Method;
  /** OpenAPI path. A single `{id}` parameter maps to `[id]` in REST_POLICIES. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: Access;
  query?: Record<string, QueryParam>;
  body?: ZodType;
  status: number;
  response?: ZodType;
  /** Media type when the response is not a single JSON document. */
  contentType?: string;
  /** Safe to repeat: the same request leaves the server in the same state. */
  idempotent: boolean;
  /** A literal request body accepted by the real handler, used by the generated examples and tests. */
  example?: unknown;
}

const workspaceId: QueryParam = { schema: z.string(), required: true, description: "Workspace to act in." };
const limit = (max: number): QueryParam => ({
  schema: z.number().int().min(1).max(max).default(50),
  description: `Maximum entries returned (1–${max}). Lists are not cursor-paginated.`,
});

const op = (o: Omit<Operation, "idempotent"> & { idempotent?: boolean }): Operation => ({
  idempotent: o.idempotent ?? ["GET", "PUT", "DELETE"].includes(o.method),
  ...o,
});

export const OPERATIONS: Operation[] = [
  op({
    id: "getHealth",
    method: "GET",
    path: "/api/health",
    tag: "Meta",
    summary: "Liveness probe",
    access: "public",
    status: 200,
    response: healthSchema,
  }),
  op({
    id: "getOpenApi",
    method: "GET",
    path: "/api/openapi.json",
    tag: "Meta",
    summary: "This API's OpenAPI document",
    access: "public",
    status: 200,
    response: z.looseObject({ openapi: z.string() }),
  }),

  // ---- workspaces
  op({
    id: "listWorkspaces",
    method: "GET",
    path: "/api/workspaces",
    tag: "Workspaces",
    summary: "List the workspaces the caller can open",
    description: "A fresh instance gets a default workspace on first use.",
    access: "account",
    status: 200,
    response: z.array(workspaceSchema),
  }),
  op({
    id: "createWorkspace",
    method: "POST",
    path: "/api/workspaces",
    tag: "Workspaces",
    summary: "Create a workspace",
    description: "The caller becomes its owner. API keys need the `write` scope.",
    access: "account",
    body: z.object({ name: z.string().min(1).max(200) }),
    status: 201,
    response: workspaceSchema,
    example: { name: "Payments API" },
  }),
  op({
    id: "renameWorkspace",
    method: "PATCH",
    path: "/api/workspaces/{id}",
    tag: "Workspaces",
    summary: "Rename a workspace",
    access: "write",
    body: z.object({ name: z.string().min(1).max(200) }),
    status: 200,
    response: workspaceSchema,
    example: { name: "Payments API (v2)" },
    idempotent: true,
  }),
  op({
    id: "deleteWorkspace",
    method: "DELETE",
    path: "/api/workspaces/{id}",
    tag: "Workspaces",
    summary: "Delete a workspace and everything in it",
    access: "manage",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "getWorkspaceTree",
    method: "GET",
    path: "/api/workspaces/{id}/tree",
    tag: "Workspaces",
    summary: "List collections, folders and request summaries",
    access: "read",
    status: 200,
    response: treeSchema,
  }),

  // ---- collections and folders
  op({
    id: "createFolder",
    method: "POST",
    path: "/api/folders",
    tag: "Collections",
    summary: "Create a collection or a folder",
    description: "Leave `parentId` out (or null) to create a collection.",
    access: "write",
    body: z.object({
      workspaceId: z.string(),
      parentId: z.string().nullish(),
      name: z.string().min(1).max(300).optional(),
    }),
    status: 201,
    response: folderSchema,
  }),
  op({
    id: "getFolder",
    method: "GET",
    path: "/api/folders/{id}",
    tag: "Collections",
    summary: "Get a collection or folder",
    access: "read",
    status: 200,
    response: folderSchema,
  }),
  op({
    id: "updateFolder",
    method: "PATCH",
    path: "/api/folders/{id}",
    tag: "Collections",
    summary: "Update a collection or folder",
    description: "Send only the fields to change. `variables` replaces a collection's variable list.",
    access: "write",
    body: z.object({
      parentId: z.string().min(1).nullable().optional(),
      name: z.string().min(1).max(300).optional(),
      description: z.string().optional(),
      headers: z.array(z.looseObject({ key: z.string(), value: z.string() })).optional(),
      preRequestScript: z.string().optional(),
      testScript: z.string().optional(),
      variables: z.array(variableSchema).optional(),
    }),
    status: 200,
    response: folderSchema,
    idempotent: true,
  }),
  op({
    id: "deleteFolder",
    method: "DELETE",
    path: "/api/folders/{id}",
    tag: "Collections",
    summary: "Delete a collection or folder with its contents",
    access: "write",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "duplicateFolder",
    method: "POST",
    path: "/api/folders/{id}/duplicate",
    tag: "Collections",
    summary: "Copy a collection or folder",
    access: "write",
    status: 201,
    response: folderSchema,
  }),

  // ---- requests
  op({
    id: "createRequest",
    method: "POST",
    path: "/api/requests",
    tag: "Requests",
    summary: "Create a request in a folder",
    access: "write",
    body: z.object({ workspaceId: z.string(), folderId: z.string(), request: requestInputSchema.optional() }),
    status: 201,
    response: requestSchema,
  }),
  op({
    id: "getRequest",
    method: "GET",
    path: "/api/requests/{id}",
    tag: "Requests",
    summary: "Get a saved request",
    access: "read",
    status: 200,
    response: requestSchema,
  }),
  op({
    id: "updateRequest",
    method: "PATCH",
    path: "/api/requests/{id}",
    tag: "Requests",
    summary: "Update a saved request",
    access: "write",
    body: requestInputSchema,
    status: 200,
    response: requestSchema,
    idempotent: true,
  }),
  op({
    id: "deleteRequest",
    method: "DELETE",
    path: "/api/requests/{id}",
    tag: "Requests",
    summary: "Delete a saved request",
    access: "write",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "duplicateRequest",
    method: "POST",
    path: "/api/requests/{id}/duplicate",
    tag: "Requests",
    summary: "Copy a saved request",
    access: "write",
    status: 201,
    response: requestSchema,
  }),

  // ---- environments and globals
  op({
    id: "listEnvironments",
    method: "GET",
    path: "/api/environments",
    tag: "Environments",
    summary: "List environments in a workspace",
    access: "read",
    query: { workspaceId },
    status: 200,
    response: z.array(environmentSummarySchema),
  }),
  op({
    id: "createEnvironment",
    method: "POST",
    path: "/api/environments",
    tag: "Environments",
    summary: "Create an environment",
    access: "write",
    body: z.object({
      workspaceId: z.string(),
      name: z.string().min(1).max(200),
      variables: z.array(variableSchema).optional(),
    }),
    status: 201,
    response: environmentSummarySchema,
    example: {
      workspaceId: "WORKSPACE_ID",
      name: "staging",
      variables: [{ key: "baseUrl", value: "https://staging.example.com", type: "default", enabled: true }],
    },
  }),
  op({
    id: "getEnvironment",
    method: "GET",
    path: "/api/environments/{id}",
    tag: "Environments",
    summary: "Get an environment with its variables",
    description: "Secret variable values are returned to callers who may edit the workspace.",
    access: "read",
    status: 200,
    response: environmentSchema,
  }),
  op({
    id: "updateEnvironment",
    method: "PATCH",
    path: "/api/environments/{id}",
    tag: "Environments",
    summary: "Rename an environment or replace its variables",
    access: "write",
    body: z.object({
      name: z.string().min(1).max(200).optional(),
      variables: z.array(variableSchema).optional(),
    }),
    status: 200,
    response: environmentSchema,
    idempotent: true,
  }),
  op({
    id: "deleteEnvironment",
    method: "DELETE",
    path: "/api/environments/{id}",
    tag: "Environments",
    summary: "Delete an environment",
    access: "write",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "duplicateEnvironment",
    method: "POST",
    path: "/api/environments/{id}/duplicate",
    tag: "Environments",
    summary: "Copy an environment with its variables",
    access: "write",
    status: 201,
    response: environmentSummarySchema,
  }),
  op({
    id: "listVariables",
    method: "GET",
    path: "/api/variables",
    tag: "Environments",
    summary: "List variables of a scope",
    description:
      "`scope=global` lists the workspace's globals; `collection` and `environment` also need `ownerId`.",
    access: "read",
    query: {
      workspaceId,
      scope: { schema: z.enum(["global", "collection", "environment"]).default("global") },
      ownerId: { schema: z.string(), description: "Collection or environment id for those scopes." },
    },
    status: 200,
    response: z.array(variableSchema.extend({ id: z.string().optional() })),
  }),
  op({
    id: "replaceVariables",
    method: "PUT",
    path: "/api/variables",
    tag: "Environments",
    summary: "Replace all variables of a scope",
    access: "write",
    body: z.object({
      workspaceId: z.string(),
      scope: z.enum(["global", "collection", "environment"]),
      ownerId: z.string().nullish(),
      variables: z.array(variableSchema),
    }),
    status: 200,
    response: z.array(variableSchema.extend({ id: z.string().optional() })),
    example: {
      workspaceId: "WORKSPACE_ID",
      scope: "global",
      variables: [{ key: "token", value: "abc", type: "secret", enabled: true }],
    },
  }),

  // ---- runs
  op({
    id: "listRuns",
    method: "GET",
    path: "/api/runs",
    tag: "Runs",
    summary: "List recent runs",
    description: "Newest first, capped at 50 entries.",
    access: "read",
    query: { workspaceId, folderId: { schema: z.string(), description: "Only runs of this collection." } },
    status: 200,
    response: z.array(runSchema),
  }),
  op({
    id: "startRun",
    method: "POST",
    path: "/api/runs",
    tag: "Runs",
    summary: "Run a collection or folder",
    description:
      "Responds with newline-delimited JSON events (`start`, `iteration`, `request`, `result`, `log`, `done`). " +
      "The run keeps going and is stored even if the client disconnects. Reference errors (404/400/429) are " +
      "reported with a normal JSON status before the stream starts.",
    access: "run",
    body: startRunSchema,
    status: 200,
    contentType: "application/x-ndjson",
    idempotent: false,
  }),
  op({
    id: "getRun",
    method: "GET",
    path: "/api/runs/{id}",
    tag: "Runs",
    summary: "Get a run with its results",
    access: "read",
    status: 200,
    response: runSchema,
  }),
  op({
    id: "deleteRun",
    method: "DELETE",
    path: "/api/runs/{id}",
    tag: "Runs",
    summary: "Delete a stored run",
    access: "write",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "cancelRun",
    method: "POST",
    path: "/api/runs/{id}/cancel",
    tag: "Runs",
    summary: "Cancel a queued or running run",
    description: "Repeating it is harmless: `cancelled` is false once the run has finished.",
    access: "run",
    status: 200,
    response: z.object({ cancelled: z.boolean() }),
    idempotent: true,
  }),

  // ---- schedules
  op({
    id: "listSchedules",
    method: "GET",
    path: "/api/schedules",
    tag: "Schedules",
    summary: "List schedules",
    access: "read",
    query: { workspaceId, folderId: { schema: z.string() } },
    status: 200,
    response: z.array(scheduleSchema),
  }),
  op({
    id: "createSchedule",
    method: "POST",
    path: "/api/schedules",
    tag: "Schedules",
    summary: "Schedule a collection run",
    access: "run",
    body: scheduleInputSchema,
    status: 201,
    response: scheduleSchema,
  }),
  op({
    id: "updateSchedule",
    method: "PATCH",
    path: "/api/schedules/{id}",
    tag: "Schedules",
    summary: "Change a schedule",
    access: "run",
    body: scheduleInputSchema.omit({ workspaceId: true }).partial(),
    status: 200,
    response: scheduleSchema,
    idempotent: true,
  }),
  op({
    id: "deleteSchedule",
    method: "DELETE",
    path: "/api/schedules/{id}",
    tag: "Schedules",
    summary: "Delete a schedule",
    access: "run",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "runSchedule",
    method: "POST",
    path: "/api/schedules/{id}/run",
    tag: "Schedules",
    summary: "Run a schedule now",
    access: "run",
    status: 202,
    response: z.looseObject({}),
    idempotent: false,
  }),

  // ---- webhooks
  op({
    id: "listWebhooks",
    method: "GET",
    path: "/api/webhooks",
    tag: "Webhooks",
    summary: "List outbound webhooks",
    access: "manage",
    query: { workspaceId },
    status: 200,
    response: z.array(webhookSchema),
  }),
  op({
    id: "createWebhook",
    method: "POST",
    path: "/api/webhooks",
    tag: "Webhooks",
    summary: "Create an outbound webhook",
    description: "The signing secret is returned once, here and when rotated.",
    access: "manage",
    body: webhookInputSchema.extend({ workspaceId: z.string() }),
    status: 201,
    response: webhookWithSecretSchema,
  }),
  op({
    id: "getWebhook",
    method: "GET",
    path: "/api/webhooks/{id}",
    tag: "Webhooks",
    summary: "Get a webhook",
    access: "manage",
    status: 200,
    response: webhookSchema,
  }),
  op({
    id: "updateWebhook",
    method: "PATCH",
    path: "/api/webhooks/{id}",
    tag: "Webhooks",
    summary: "Change a webhook",
    access: "manage",
    body: webhookInputSchema.partial(),
    status: 200,
    response: webhookSchema,
    idempotent: true,
  }),
  op({
    id: "deleteWebhook",
    method: "DELETE",
    path: "/api/webhooks/{id}",
    tag: "Webhooks",
    summary: "Delete a webhook and its delivery log",
    access: "manage",
    status: 200,
    response: okSchema,
  }),
  op({
    id: "rotateWebhookSecret",
    method: "POST",
    path: "/api/webhooks/{id}/rotate",
    tag: "Webhooks",
    summary: "Replace the signing secret",
    access: "manage",
    status: 200,
    response: webhookWithSecretSchema,
    idempotent: false,
  }),
  op({
    id: "testWebhook",
    method: "POST",
    path: "/api/webhooks/{id}/test",
    tag: "Webhooks",
    summary: "Queue a test event",
    access: "manage",
    status: 202,
    response: z.looseObject({ id: z.string(), status: z.string() }),
    idempotent: false,
  }),
  op({
    id: "listWebhookDeliveries",
    method: "GET",
    path: "/api/webhooks/{id}/deliveries",
    tag: "Webhooks",
    summary: "List deliveries, or fetch one with `delivery`",
    access: "manage",
    query: {
      status: { schema: z.string(), description: "Filter by delivery status." },
      limit: limit(200),
      delivery: {
        schema: z.string(),
        description: "Return this delivery with its attempts instead of a list.",
      },
    },
    status: 200,
    response: z.array(z.looseObject({ id: z.string(), status: z.string() })),
  }),
  op({
    id: "replayWebhookDelivery",
    method: "POST",
    path: "/api/webhooks/{id}/replay",
    tag: "Webhooks",
    summary: "Send a finished delivery again",
    access: "manage",
    body: z.object({ deliveryId: z.string().min(1) }),
    status: 202,
    response: z.looseObject({ id: z.string(), status: z.string() }),
    idempotent: false,
  }),

  // ---- settings
  op({
    id: "getSettings",
    method: "GET",
    path: "/api/settings",
    tag: "Settings",
    summary: "Read effective settings",
    access: "account",
    status: 200,
    response: settingsSchema,
  }),
  op({
    id: "updateSettings",
    method: "PATCH",
    path: "/api/settings",
    tag: "Settings",
    summary: "Change settings",
    description: "`null` resets a key to its default. Instance-wide keys need an administrator.",
    access: "account",
    body: z.object({ values: z.record(z.string(), z.unknown()) }),
    status: 200,
    response: settingsSchema,
    idempotent: true,
  }),
];

export const policyKey = (o: Pick<Operation, "method" | "path">) =>
  `${o.method} ${o.path.replaceAll("{id}", "[id]")}`;

/** The documented error envelope, shared by every operation. */
export { errorSchema };
