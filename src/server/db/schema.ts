import type { DocumentationSnapshot } from "@/core/documentation/model";
import type { RequestContract } from "@/core/contracts/model";
import type { MockRoute } from "@/core/mocks/model";
import type { LoadProfile } from "@/core/load/profile";
import type { LoadSnapshot } from "@/core/load/metrics";
import type { Threshold, ThresholdResult } from "@/core/load/thresholds";
import type { MockHandler } from "@/core/mocks/handlers";
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

/** The outcome of a load test, kept as one document: metrics, the time series and threshold results. */
export interface LoadResultDoc {
  stoppedBy: "cancelled" | "maxRequests" | null;
  snapshot: LoadSnapshot;
  thresholds: ThresholdResult[];
  warnings: string[];
}

export const loadRuns = sqliteTable(
  "load_runs",
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
    profile: text("profile", { mode: "json" }).$type<LoadProfile>().notNull(),
    thresholds: text("thresholds", { mode: "json" }).$type<Threshold[]>().notNull().default([]),
    thinkMs: integer("think_ms").notNull().default(0),
    environmentId: text("environment_id"),
    datasetId: text("dataset_id"),
    datasetVersion: integer("dataset_version"),
    result: text("result", { mode: "json" }).$type<LoadResultDoc>(),
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by").references(() => users.id),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("load_runs_workspace_idx").on(t.workspaceId, t.startedAt)],
);

/**
 * A secret in the vault. `ciphertext` is AES-256-GCM output (src/core/vault/crypto.ts); the key lives outside
 * the database and backups. Empty ciphertext means the value was withheld (a backup without secrets).
 */
export const vaultSecrets = sqliteTable(
  "vault_secrets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ciphertext: text("ciphertext").notNull().default(""),
    keyId: text("key_id").notNull().default(""),
    /** Off: references stay unresolved without deleting the secret. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Hosts it may be sent to (`host`, `*.domain`); empty means any host. */
    domains: text("domains", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** A user id for a personal secret that only that user's executions can use; empty for workspace secrets. */
    ownerId: text("owner_id").notNull().default(""),
    /** May scripts read it with pm.vault.get()? References in requests do not need this. */
    scriptAccess: integer("script_access", { mode: "boolean" }).notNull().default(false),
    /** Collections (folder ids) that may reference it; empty means the whole workspace. */
    collectionIds: text("collection_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** When the value was last replaced (or re-encrypted under a new key). */
    rotatedAt: integer("rotated_at"),
  },
  (t) => [uniqueIndex("vault_secrets_name_unique").on(t.workspaceId, t.name, t.ownerId)],
);

/**
 * An API whose credential the broker injects. The credential itself stays in the vault (`secretName`); a consumer
 * only ever holds a grant, never the value.
 */
export const brokerApis = sqliteTable(
  "broker_apis",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Calls go to this URL plus a path the consumer supplies. */
    baseUrl: text("base_url").notNull(),
    /** Name of the workspace vault secret that holds the credential. */
    secretName: text("secret_name").notNull(),
    /** How the credential is attached: bearer, header, basic or query. */
    injection: text("injection", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Methods any consumer may use; empty means all. */
    methods: text("methods", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Path prefixes any consumer may reach; empty means everything under the base URL. */
    pathPrefixes: text("path_prefixes", { mode: "json" }).$type<string[]>().notNull().default([]),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("broker_apis_name_unique").on(t.workspaceId, t.name)],
);

/**
 * One consumer's access to one brokered API. Its id is the reference the consumer presents; it is useless to anyone
 * else because the call must also come from the consumer it was approved for.
 */
export const brokerGrants = sqliteTable(
  "broker_grants",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    apiId: text("api_id")
      .notNull()
      .references(() => brokerApis.id, { onDelete: "cascade" }),
    /** A user id (service accounts included), or "open" / "env" for the single-user and environment modes. */
    consumerId: text("consumer_id").notNull(),
    consumerName: text("consumer_name").notNull().default(""),
    /** When set, only that API key (of the consumer) may use the grant. */
    tokenId: text("token_id"),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull().default(""),
    /** Narrower than the API's own limits; empty means the API's. */
    methods: text("methods", { mode: "json" }).$type<string[]>().notNull().default([]),
    pathPrefixes: text("path_prefixes", { mode: "json" }).$type<string[]>().notNull().default([]),
    requestedBy: text("requested_by"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("broker_grants_api_idx").on(t.apiId),
    index("broker_grants_consumer_idx").on(t.workspaceId, t.consumerId),
  ],
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
    handlers: text("handlers", { mode: "json" }).$type<MockHandler[]>().notNull().default([]),
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
    /** postbox | slack | discord | teams | pagerduty (src/core/webhook-adapters.ts). */
    format: text("format").notNull().default("postbox"),
    /** Name of the vault secret holding the signing key; when set, `secret` is empty. */
    secretRef: text("secret_ref").notNull().default(""),
    /** Vault secret holding the PagerDuty routing key. */
    routingKeyRef: text("routing_key_ref").notNull().default(""),
    /** JSON [{name, value}]; values may be {{vault:name}} references and are never returned by the API. */
    headers: text("headers").notNull().default("[]"),
    /** Consecutive failed deliveries after which the webhook is paused; 0 never pauses. */
    pauseAfterFailures: integer("pause_after_failures").notNull().default(0),
    failureStreak: integer("failure_streak").notNull().default(0),
    pausedAt: integer("paused_at"),
    pauseReason: text("pause_reason").notNull().default(""),
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

export const catalogEntries = sqliteTable(
  "catalog_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    owners: text("owners", { mode: "json" }).$type<string[]>().notNull(),
    visibility: text("visibility").$type<"private" | "team" | "public">().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull(),
    latestVersion: integer("latest_version").notNull(),
    latestLabel: text("latest_label").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("catalog_folder_unique").on(t.folderId),
    index("catalog_visibility_updated_idx").on(t.visibility, t.updatedAt),
    index("catalog_workspace_idx").on(t.workspaceId),
  ],
);
export const catalogVersions = sqliteTable(
  "catalog_versions",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => catalogEntries.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    label: text("label").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<DocumentationSnapshot>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.version] }),
    uniqueIndex("catalog_version_label_unique").on(t.entryId, t.label),
  ],
);

/** An inbound webhook endpoint (`/hook/<token>`). The token is the credential and is stored hashed. */
export const hookListeners = sqliteTable(
  "hook_listeners",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** active | paused | revoked */
    status: text("status").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** Last characters of the token, so owners can tell listeners apart without storing it. */
    tokenHint: text("token_hint").notNull(),
    /** JSON VerificationConfig. */
    verification: text("verification").notNull(),
    /** Shared secret for verification. Never listed or returned after it is set. */
    secret: text("secret").notNull().default(""),
    responseStatus: integer("response_status").notNull().default(200),
    responseContentType: text("response_content_type").notNull().default("application/json"),
    responseBody: text("response_body").notNull().default('{"ok":true}'),
    forwardUrl: text("forward_url"),
    ratePerMinute: integer("rate_per_minute").notNull().default(120),
    receivedCount: integer("received_count").notNull().default(0),
    lastReceivedAt: integer("last_received_at"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("hook_listeners_workspace_idx").on(t.workspaceId)],
);

/** One request received by a listener, bounded in count, size and age. */
export const hookEvents = sqliteTable(
  "hook_events",
  {
    id: text("id").primaryKey(),
    listenerId: text("listener_id")
      .notNull()
      .references(() => hookListeners.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    receivedAt: integer("received_at").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    query: text("query").notNull(),
    /** JSON array of [name, value] with credentials redacted. */
    headers: text("headers").notNull(),
    body: text("body").notNull(),
    /** utf8 | base64 */
    bodyEncoding: text("body_encoding").notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    /** none | valid | invalid | missing */
    signature: text("signature").notNull(),
    responseStatus: integer("response_status").notNull(),
    /** Set once a forward or a user-requested replay has been attempted. */
    forwardStatus: integer("forward_status"),
    forwardError: text("forward_error"),
    forwardedAt: integer("forwarded_at"),
    replays: integer("replays").notNull().default(0),
  },
  (t) => [index("hook_events_listener_idx").on(t.listenerId, t.receivedAt)],
);

/**
 * A recording session. Requests sent to `/capture/<token>/<absolute URL>` are relayed and
 * recorded. The token is the credential and is stored hashed; HTTPS recording and cookie
 * capture are separate opt-ins.
 */
export const captureSessions = sqliteTable(
  "capture_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** recording | paused | stopped */
    status: text("status").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenHint: text("token_hint").notNull(),
    /** Explicit consent to record https:// targets (and who gave it, when). */
    allowHttps: integer("allow_https", { mode: "boolean" }).notNull().default(false),
    httpsConsentBy: text("https_consent_by"),
    httpsConsentAt: integer("https_consent_at"),
    /** Keep non-credential cookie values instead of masking every cookie. */
    captureCookies: integer("capture_cookies", { mode: "boolean" }).notNull().default(false),
    /** JSON array of host filters; empty records any host the outbound policy allows. */
    hosts: text("hosts").notNull().default("[]"),
    entryCount: integer("entry_count").notNull().default(0),
    lastCapturedAt: integer("last_captured_at"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("capture_sessions_workspace_idx").on(t.workspaceId)],
);

/** One recorded exchange, stored with credentials already removed. */
export const captureEntries = sqliteTable(
  "capture_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => captureSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    startedAt: integer("started_at").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestHeaders: text("request_headers").notNull(),
    /** JSON CapturedBody. */
    requestBody: text("request_body").notNull(),
    status: integer("status"),
    statusText: text("status_text").notNull().default(""),
    responseHeaders: text("response_headers").notNull().default("[]"),
    responseBody: text("response_body").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    /** How many credential values were removed, so reviewers know it happened. */
    redactions: integer("redactions").notNull().default(0),
    importedAt: integer("imported_at"),
  },
  (t) => [index("capture_entries_session_idx").on(t.sessionId, t.startedAt)],
);

/** The single outbound proxy (id "default"). Credentials are write-only through the API. */
export const outboundProxy = sqliteTable("outbound_proxy", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  url: text("url").notNull(),
  username: text("username").notNull().default(""),
  password: text("password").notNull().default(""),
  /** JSON array of bypass patterns. */
  bypass: text("bypass", { mode: "json" }).$type<string[]>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A custom CA and/or client certificate used for matching hosts. The key never leaves the server. */
export const tlsProfiles = sqliteTable("tls_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** JSON array of host patterns: host, *.domain or host:port. */
  hosts: text("hosts", { mode: "json" }).$type<string[]>().notNull(),
  caPem: text("ca_pem").notNull().default(""),
  certPem: text("cert_pem").notNull().default(""),
  keyPem: text("key_pem").notNull().default(""),
  passphrase: text("passphrase").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type HookListenerRow = typeof hookListeners.$inferSelect;
export type HookEventRow = typeof hookEvents.$inferSelect;
export type CaptureSessionRow = typeof captureSessions.$inferSelect;
export type CaptureEntryRow = typeof captureEntries.$inferSelect;

/** Workspace-scoped external MCP call templates; credentials are variable references. */
export const mcpCalls = sqliteTable(
  "mcp_calls",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).$type<import("@/core/mcp-client/model").McpCall>().notNull(),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [index("mcp_calls_workspace_idx").on(t.workspaceId)],
);

/** A collection schedule with retained monitoring state and threshold policy. */
export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id")
      .notNull()
      .unique()
      .references(() => schedules.id, { onDelete: "cascade" }),
    rules: text("rules", { mode: "json" }).$type<import("@/core/monitoring/model").MonitorRules>().notNull(),
    emails: text("emails", { mode: "json" }).$type<string[]>().notNull(),
    state: text("state").notNull().default("unknown"),
    failures: integer("failures").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    openIncidentId: text("open_incident_id"),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [index("monitors_workspace_idx").on(t.workspaceId)],
);
export const monitorSamples = sqliteTable(
  "monitor_samples",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().unique(),
    at: integer("at").notNull(),
    outcome: text("outcome").notNull(),
    metrics: text("metrics", { mode: "json" })
      .$type<import("@/core/monitoring/model").MonitorMetrics>()
      .notNull(),
    reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [index("monitor_samples_time_idx").on(t.monitorId, t.at)],
);
export const monitorIncidents = sqliteTable(
  "monitor_incidents",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    resolvedAt: integer("resolved_at"),
    reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
    openingRunId: text("opening_run_id").notNull(),
    recoveryRunId: text("recovery_run_id"),
  },
  (t) => [index("monitor_incidents_time_idx").on(t.monitorId, t.startedAt)],
);
export const monitorEmails = sqliteTable(
  "monitor_emails",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    incidentId: text("incident_id")
      .notNull()
      .references(() => monitorIncidents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lockedUntil: integer("locked_until"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    uniqueIndex("monitor_email_event_unique").on(t.incidentId, t.kind, t.recipient),
    index("monitor_email_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const specifications = sqliteTable("specifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  format: text("format").$type<import("@/core/specifications/model").SpecificationFormat>().notNull(),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const specificationVersions = sqliteTable(
  "specification_versions",
  {
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    entrypoint: text("entrypoint").notNull(),
    files: text("files", { mode: "json" })
      .$type<import("@/core/specifications/model").SpecificationSource["files"]>()
      .notNull(),
    label: text("label").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.specificationId, t.version] })],
);

export const specificationLinks = sqliteTable("specification_links", {
  folderId: text("folder_id")
    .primaryKey()
    .references(() => folders.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  specificationId: text("specification_id")
    .notNull()
    .references(() => specifications.id, { onDelete: "cascade" }),
  specVersion: integer("spec_version").notNull(),
  revision: integer("revision").notNull().default(1),
  baseline: text("baseline", { mode: "json" })
    .$type<import("@/server/specification-sync").SyncBaseline>()
    .notNull(),
  ...timestamps,
});

export const governanceRuleSets = sqliteTable("governance_rule_sets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const governanceRuleVersions = sqliteTable(
  "governance_rule_versions",
  {
    ruleSetId: text("rule_set_id")
      .notNull()
      .references(() => governanceRuleSets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: text("config", { mode: "json" })
      .$type<import("@/core/governance/model").GovernanceConfig>()
      .notNull(),
    label: text("label").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ruleSetId, t.version] })],
);
export const governanceBindings = sqliteTable("governance_bindings", {
  specificationId: text("specification_id")
    .primaryKey()
    .references(() => specifications.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ruleSetId: text("rule_set_id")
    .notNull()
    .references(() => governanceRuleSets.id, { onDelete: "cascade" }),
  ruleVersion: integer("rule_version"),
  overrides: text("overrides", { mode: "json" })
    .$type<Record<string, import("@/core/governance/model").GovernanceSeverity>>()
    .notNull()
    .default({}),
  exclusions: text("exclusions", { mode: "json" })
    .$type<import("@/core/governance/model").GovernanceExclusion[]>()
    .notNull()
    .default([]),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const governanceReports = sqliteTable(
  "governance_reports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id, { onDelete: "cascade" }),
    specVersion: integer("spec_version").notNull(),
    ruleSetId: text("rule_set_id")
      .notNull()
      .references(() => governanceRuleSets.id, { onDelete: "cascade" }),
    ruleVersion: integer("rule_version").notNull(),
    bindingRevision: integer("binding_revision").notNull(),
    report: text("report", { mode: "json" })
      .$type<import("@/core/governance/model").GovernanceReport>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("governance_reports_spec_time").on(t.specificationId, t.createdAt)],
);

/**
 * The dependency graph. A source is one thing whose facts were indexed (a collection, a specification, a monitor, ...);
 * its nodes and edges are replaced together and deleted with it.
 */
export const graphSources = sqliteTable(
  "graph_sources",
  {
    /** `<kind>:<ref>` */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    label: text("label").notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").$type<import("@/core/graph/model").SourceState>().notNull(),
    error: text("error"),
    /** Telemetry sources are indexed only while connected. */
    connected: integer("connected", { mode: "boolean" }).notNull().default(true),
    indexedAt: integer("indexed_at").notNull(),
    checkedAt: integer("checked_at").notNull(),
  },
  (t) => [index("graph_sources_workspace_idx").on(t.workspaceId, t.kind)],
);
export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => graphSources.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    workspaceId: text("workspace_id"),
    label: text("label").notNull(),
    props: text("props", { mode: "json" })
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.id] }),
    index("graph_nodes_id_idx").on(t.id),
    index("graph_nodes_workspace_idx").on(t.workspaceId, t.kind),
  ],
);
export const graphEdges = sqliteTable(
  "graph_edges",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => graphSources.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    from: text("from_id").notNull(),
    to: text("to_id").notNull(),
    type: text("type").notNull(),
    origin: text("origin").notNull(),
    props: text("props", { mode: "json" })
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.from, t.type, t.to] }),
    index("graph_edges_workspace_idx").on(t.workspaceId),
    index("graph_edges_from_idx").on(t.from),
    index("graph_edges_to_idx").on(t.to),
  ],
);
export type GraphSourceRow = typeof graphSources.$inferSelect;

export const qualityScorecards = sqliteTable("quality_scorecards", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const qualityScorecardVersions = sqliteTable(
  "quality_scorecard_versions",
  {
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => qualityScorecards.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: text("config", { mode: "json" })
      .$type<import("@/core/scorecards/model").ScorecardConfig>()
      .notNull(),
    label: text("label").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scorecardId, t.version] })],
);
export const qualityBindings = sqliteTable(
  "quality_bindings",
  {
    id: text("id").primaryKey(),
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => qualityScorecards.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => catalogEntries.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull().default(""),
    specificationId: text("specification_id").references(() => specifications.id, { onDelete: "set null" }),
    monitorId: text("monitor_id").references(() => monitors.id, { onDelete: "set null" }),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex("quality_bindings_slice_unique").on(t.scorecardId, t.entryId, t.environmentId)],
);
export const qualityReports = sqliteTable(
  "quality_reports",
  {
    id: text("id").primaryKey(),
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => qualityScorecards.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    report: text("report", { mode: "json" }).$type<import("@/server/scorecards").QualityReport>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("quality_reports_card_time").on(t.scorecardId, t.createdAt)],
);

/**
 * Discussions on API elements (a request, a folder or collection, a specification). Replies point at
 * a top-level comment through parentId; the element is polymorphic so deleting it is cleaned up in code.
 */
export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<import("@/core/comments/model").CommentTarget>().notNull(),
    targetId: text("target_id").notNull(),
    parentId: text("parent_id"),
    body: text("body").notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Kept so a thread still reads correctly after the account is removed. */
    authorName: text("author_name").notNull(),
    mentions: text("mentions", { mode: "json" }).$type<string[]>().notNull(),
    /** The element's revision (or last-change time) when the comment was written. */
    revision: text("revision").notNull().default(""),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by"),
    editedAt: integer("edited_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("comments_target_idx").on(t.targetKind, t.targetId, t.createdAt),
    index("comments_parent_idx").on(t.parentId),
    index("comments_workspace_idx").on(t.workspaceId),
  ],
);
/** One row per person told about a comment (a mention, or a reply to their comment). */
export const commentNotifications = sqliteTable(
  "comment_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"mention" | "reply">().notNull(),
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("comment_notifications_user_idx").on(t.userId, t.readAt, t.createdAt)],
);
