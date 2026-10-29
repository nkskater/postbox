/**
 * Drizzle schema for the Postbox SQLite database.
 *
 * Structured parts of requests/folders (headers, body, auth, ...) are stored as
 * JSON text columns because they are always read and written as a unit.
 * See ARCHITECTURE.md §3 for the rationale.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
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
  (t) => [index("folders_workspace_idx").on(t.workspaceId), index("folders_parent_idx").on(t.parentId)],
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
    examples: text("examples", { mode: "json" }).$type<ResponseExample[]>().notNull(),
    description: text("description").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("requests_folder_idx").on(t.folderId)],
);

export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  ...timestamps,
});

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

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: text("folder_id"),
    name: text("name").notNull(),
    status: text("status").$type<"running" | "passed" | "failed" | "cancelled" | "error">().notNull(),
    options: text("options", { mode: "json" }).$type<RunOptions>().notNull(),
    environmentId: text("environment_id"),
    iterations: integer("iterations").notNull().default(1),
    totalRequests: integer("total_requests").notNull().default(0),
    totalTests: integer("total_tests").notNull().default(0),
    passedTests: integer("passed_tests").notNull().default(0),
    failedTests: integer("failed_tests").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    source: text("source").notNull().default("manual"),
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
  name: text("name").notNull(),
  folderId: text("folder_id").notNull(),
  environmentId: text("environment_id"),
  cron: text("cron").notNull(),
  options: text("options", { mode: "json" }).$type<RunOptions>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at"),
  lastRunId: text("last_run_id"),
  ...timestamps,
});

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
