import type { DocumentationSnapshot } from "@/core/documentation/model";
import type { RequestContract } from "@/core/contracts/model";
import type { MockRoute } from "@/core/mocks/model";
import type { Scenario } from "@/core/mocks/scenarios";
import type { ExecutionDetails } from "@/core/runner/details";
import type { AuditChange } from "@/core/audit";
/**
 * Drizzle schema for the Postbox SQLite database.
 *
 * Structured parts of requests/folders (headers, body, auth, ...) are stored as
 * JSON text columns because they are always read and written as a unit.
 * See ARCHITECTURE.md §3 for the rationale.
 */
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import type {
  DataTable,
  AuthConfig,
  BodyConfig,
  KeyValue,
  RequestSettings,
  ResponseExample,
  RunOptions,
  TestResult,
} from "@/core/types";

const timestamps = {
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
};

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

/** A folder whose parentId is null is a collection. */
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    description: text("description").notNull().default(""),
    auth: text("auth", { mode: "json" }).$type<AuthConfig>().notNull(),
    headers: text("headers", { mode: "json" }).$type<KeyValue[]>().notNull(),
    preRequestScript: text("pre_request_script").notNull().default(""),
    testScript: text("test_script").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("folders_workspace_idx").on(t.workspaceId),
    index("folders_parent_idx").on(t.parentId),
    index("folders_workspace_parent_sort_idx").on(t.workspaceId, t.parentId, t.sort),
  ],
);

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    method: text("method").notNull(),
    url: text("url").notNull().default(""),
    params: text("params", { mode: "json" }).$type<KeyValue[]>().notNull(),
    headers: text("headers", { mode: "json" }).$type<KeyValue[]>().notNull(),
    body: text("body", { mode: "json" }).$type<BodyConfig>().notNull(),
    auth: text("auth", { mode: "json" }).$type<AuthConfig>().notNull(),
    preRequestScript: text("pre_request_script").notNull().default(""),
    testScript: text("test_script").notNull().default(""),
    settings: text("settings", { mode: "json" }).$type<RequestSettings>().notNull(),
    contract: text("contract", { mode: "json" }).$type<RequestContract | null>(),
    examples: text("examples", { mode: "json" }).$type<ResponseExample[]>().notNull(),
    description: text("description").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("requests_folder_idx").on(t.folderId),
    index("requests_folder_sort_idx").on(t.folderId, t.sort),
    index("requests_workspace_sort_idx").on(t.workspaceId, t.sort, t.createdAt),
  ],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("environments_workspace_sort_idx").on(t.workspaceId, t.sort, t.createdAt)],
);

export const variables = sqliteTable(
  "variables",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** 'global' | 'collection' | 'environment' */
    scope: text("scope").$type<"global" | "collection" | "environment">().notNull(),
    /** environment id, collection folder id, or null for globals */
    ownerId: text("owner_id"),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
    type: text("type").$type<"default" | "secret">().notNull().default("default"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("variables_scope_idx").on(t.workspaceId, t.scope, t.ownerId)],
);

export const datasets = sqliteTable(
  "datasets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    latestVersion: integer("latest_version").notNull(),
    createdBy: text("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [index("datasets_workspace_idx").on(table.workspaceId, table.updatedAt)],
);
export const datasetVersions = sqliteTable(
  "dataset_versions",
  {
    datasetId: text("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    table: text("data", { mode: "json" }).$type<DataTable>().notNull(),
    secretColumns: text("secret_columns", { mode: "json" }).$type<string[]>().notNull(),
    rowCount: integer("row_count").notNull(),
    columns: text("columns", { mode: "json" }).$type<string[]>().notNull(),
    missingSecrets: integer("missing_secrets", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => users.id),
  },
  (table) => [primaryKey({ columns: [table.datasetId, table.version] })],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id"),
    name: text("name").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "passed" | "failed" | "cancelled" | "error">()
      .notNull(),
    options: text("options", { mode: "json" }).$type<RunOptions>().notNull(),
    environmentId: text("environment_id"),
    datasetId: text("dataset_id"),
    datasetVersion: integer("dataset_version"),
    datasetName: text("dataset_name"),
    iterations: integer("iterations").notNull().default(1),
    totalRequests: integer("total_requests").notNull().default(0),
    totalTests: integer("total_tests").notNull().default(0),
    passedTests: integer("passed_tests").notNull().default(0),
    failedTests: integer("failed_tests").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdBy: text("created_by").references(() => users.id),
    source: text("source").notNull().default("manual"),
    failedRequests: integer("failed_requests").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("runs_workspace_idx").on(t.workspaceId, t.startedAt)],
);

export const runResults = sqliteTable(
  "run_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull(),
    sequence: integer("sequence").notNull(),
    requestId: text("request_id"),
    name: text("name").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    status: integer("status"),
    statusText: text("status_text"),
    timeMs: integer("time_ms"),
    size: integer("size"),
    tests: text("tests", { mode: "json" }).$type<TestResult[]>().notNull(),
    error: text("error"),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    path: text("path").notNull().default(""),
    skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),
    scriptErrors: text("script_errors", { mode: "json" })
      .$type<{ phase: "prerequest" | "test"; source: string; message: string }[]>()
      .notNull()
      .default([]),
    executionDetails: text("execution_details", { mode: "json" }).$type<ExecutionDetails>(),
    responseBody: text("response_body"),
    responseHeaders: text("response_headers", { mode: "json" }).$type<[string, string][]>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("run_results_run_idx").on(t.runId, t.sequence)],
);

export const history = sqliteTable(
  "history",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id),
    requestId: text("request_id"),
    method: text("method").notNull(),
    url: text("url").notNull(),
    status: integer("status"),
    timeMs: integer("time_ms"),
    size: integer("size"),
    /** The request template as it was in the editor (unresolved). */
    request: text("request", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Response summary (status, headers, truncated body). */
    response: text("response", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("history_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const cookies = sqliteTable(
  "cookies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    path: text("path").notNull().default("/"),
    name: text("name").notNull(),
    value: text("value").notNull(),
    expires: integer("expires"),
    httpOnly: integer("http_only", { mode: "boolean" }).notNull().default(false),
    secure: integer("secure", { mode: "boolean" }).notNull().default(false),
    sameSite: text("same_site"),
    hostOnly: integer("host_only", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("cookies_identity_idx").on(t.workspaceId, t.domain, t.path, t.name)],
);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id),
  name: text("name").notNull(),
  folderId: text("folder_id").notNull(),
  environmentId: text("environment_id"),
  datasetId: text("dataset_id").references(() => datasets.id, { onDelete: "no action" }),
  datasetVersion: integer("dataset_version"),
  cron: text("cron").notNull(),
  options: text("options", { mode: "json" }).$type<RunOptions>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at"),
  lastRunId: text("last_run_id"),
  ...timestamps,
});

/** App-wide settings (key -> JSON value). Keys and validation live in src/lib/settings/registry.ts. */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Local accounts. Bumping session_version invalidates every session cookie of the user. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    /** A service identity: no password or sessions, only API keys, with workspace roles like any user. */
    isService: integer("is_service", { mode: "boolean" }).notNull().default(false),
    sessionVersion: integer("session_version").notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_username_unique").on(t.username)],
);

/** Personal API tokens. Only a SHA-256 hash of the token is stored. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, shown so users can tell tokens apart. */
    prefix: text("prefix").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    /** read | run | write | full (src/core/scopes.ts). Keys created before scopes existed are full. */
    scope: text("scope").$type<"read" | "run" | "write" | "full">().notNull().default("full"),
    /** Requests per minute allowed for this key; null means unlimited. */
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("api_tokens_hash_unique").on(t.tokenHash), index("api_tokens_user_idx").on(t.userId)],
);

/** Server-generated secrets (e.g. the session signing key). Never exported with settings. */
export const serverSecrets = sqliteTable("server_secrets", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type VariableRow = typeof variables.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunResultRow = typeof runResults.$inferSelect;
export type HistoryRow = typeof history.$inferSelect;
export type CookieRow = typeof cookies.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "editor" | "viewer">().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "editor" | "viewer">(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("invites_token_unique").on(t.tokenHash),
    index("invites_workspace_idx").on(t.workspaceId),
  ],
);

export const mockServers = sqliteTable(
  "mock_servers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
    matchQuery: integer("match_query", { mode: "boolean" }).notNull().default(true),
    matchBody: integer("match_body", { mode: "boolean" }).notNull().default(true),
    delayMs: integer("delay_ms").notNull().default(0),
    status: integer("status"),
    headers: text("headers", { mode: "json" }).$type<KeyValue[]>().notNull(),
    routes: text("routes", { mode: "json" }).$type<MockRoute[]>().notNull(),
    scenarios: text("scenarios", { mode: "json" }).$type<Scenario[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    keyHash: text("key_hash").notNull(),
    ...timestamps,
  },
  (t) => [index("mock_workspace_idx").on(t.workspaceId)],
);
/** Shared gRPC .proto sets: requests point at one with settings.grpc.definitionId. */
export const grpcDefinitions = sqliteTable(
  "grpc_definitions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** .proto sources by file name; imports resolve only against these (plus well-known types). */
    files: text("files", { mode: "json" }).$type<Record<string, string>>().notNull(),
    /** Incremented on every change to the files. */
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("grpc_definitions_workspace_idx").on(t.workspaceId),
    uniqueIndex("grpc_definitions_name_unique").on(t.workspaceId, t.name),
  ],
);
export const mockLogs = sqliteTable(
  "mock_logs",
  {
    id: text("id").primaryKey(),
    mockId: text("mock_id")
      .notNull()
      .references(() => mockServers.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    exampleId: text("example_id"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("mock_logs_time_idx").on(t.mockId, t.createdAt)],
);

/**
 * Who changed what, and when. Rows reference entities by id without foreign keys, so the trail
 * outlives deleted workspaces and users. Values of secrets are never stored (see src/core/audit.ts).
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    actorId: text("actor_id"),
    /** Username at the time, so the trail stays readable after an account is removed. */
    actorName: text("actor_name").notNull(),
    /** user | service | env | open | system */
    actorKind: text("actor_kind").notNull(),
    /** session | token | mcp, when known. */
    via: text("via"),
    keyId: text("key_id"),
    workspaceId: text("workspace_id"),
    action: text("action").notNull(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id"),
    entityName: text("entity_name"),
    /** 1 for the first recorded event of an entity, then counting up. */
    revision: integer("revision").notNull().default(1),
    /** ok | denied */
    result: text("result").notNull().default("ok"),
    method: text("method"),
    path: text("path"),
    changes: text("changes", { mode: "json" }).$type<AuditChange[]>().notNull(),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index("audit_at_idx").on(t.at),
    index("audit_workspace_idx").on(t.workspaceId, t.at),
    index("audit_actor_idx").on(t.actorId, t.at),
    index("audit_entity_idx").on(t.entityKind, t.entityId),
  ],
);

/**
 * Usage ledger: one row per counted amount. `idemKey` makes retries count once: the same key in the
 * same workspace is recorded only the first time. Rows outlive deleted workspaces (no foreign keys).
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** The user or service account that caused it, when there is one. */
    actorId: text("actor_id"),
    /** requests | runs | run_ms | ai_tokens (src/core/usage.ts) */
    metric: text("metric").notNull(),
    amount: integer("amount").notNull(),
    idemKey: text("idem_key"),
  },
  (t) => [
    index("usage_workspace_idx").on(t.workspaceId, t.metric, t.at),
    index("usage_actor_idx").on(t.actorId, t.metric, t.at),
    uniqueIndex("usage_idem_unique").on(t.workspaceId, t.idemKey),
  ],
);

/**
 * A quota. With neither workspace nor user it is the default for every workspace; with a workspace it
 * overrides that default; with a user (a person or service account) it caps that identity across all
 * workspaces. Null limits mean none. Soft limits raise an alert, hard limits refuse.
 */
export const usageLimits = sqliteTable("usage_limits", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  userId: text("user_id"),
  metric: text("metric").notNull(),
  /** day | month (UTC); ignored for stock metrics such as storage. */
  period: text("period").notNull().default("month"),
  softLimit: integer("soft_limit"),
  hardLimit: integer("hard_limit"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Soft-limit crossings and hard-limit refusals, once per limit, workspace and period. */
export const usageAlerts = sqliteTable(
  "usage_alerts",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    limitId: text("limit_id").notNull(),
    /** Empty for identity limits, which span workspaces. */
    workspaceId: text("workspace_id").notNull().default(""),
    userId: text("user_id"),
    metric: text("metric").notNull(),
    /** soft | hard */
    kind: text("kind").notNull(),
    periodStart: integer("period_start").notNull(),
    used: integer("used").notNull(),
    limitValue: integer("limit_value").notNull(),
  },
  (t) => [
    uniqueIndex("usage_alert_unique").on(t.limitId, t.workspaceId, t.kind, t.periodStart),
    index("usage_alert_at_idx").on(t.at),
  ],
);

export const scriptPackages = sqliteTable(
  "script_packages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    latestVersion: integer("latest_version").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("script_packages_name_idx").on(t.workspaceId, t.name)],
);
export const scriptPackageVersions = sqliteTable(
  "script_package_versions",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => scriptPackages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    hash: text("hash").notNull(),
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => users.id),
    approvedBy: text("approved_by").references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.version] })],
);

export const documentationPublications = sqliteTable(
  "documentation_publications",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    visibility: text("visibility").$type<"private" | "public">().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull(),
    customOrigin: text("custom_origin").notNull().default(""),
    snapshot: text("snapshot", { mode: "json" }).$type<DocumentationSnapshot>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("documentation_folder_unique").on(t.folderId),
    index("documentation_workspace_idx").on(t.workspaceId),
  ],
);

/** An outbound webhook endpoint a workspace owner configured. Nothing is sent without one. */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** Signing key. Returned once on creation or rotation, never listed afterwards. */
    secret: text("secret").notNull(),
    /** JSON array of event types. */
    events: text("events").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("webhooks_workspace_idx").on(t.workspaceId)],
);

/** One event queued for one webhook. The id is the same on every retry. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    /** pending | delivered | failed */
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    /** A worker holds the delivery until then; a crashed worker's claim simply expires. */
    lockedUntil: integer("locked_until"),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    replayOf: text("replay_of"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("webhook_delivery_hook_idx").on(t.webhookId, t.createdAt),
    index("webhook_delivery_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const webhookAttempts = sqliteTable(
  "webhook_attempts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    status: integer("status"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("webhook_attempt_delivery_idx").on(t.deliveryId, t.at)],
);
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
