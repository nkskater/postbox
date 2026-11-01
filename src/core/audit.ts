/**
 * Audit trail helpers: pure functions with no database or framework imports.
 *
 * Events never carry secret values. A change is described by field name; only fields on a
 * per-entity allowlist keep their before and after values, and URLs lose credentials and query values.
 */
export type AuditEntityKind =
  | "workspace"
  | "folder"
  | "request"
  | "environment"
  | "variable"
  | "run"
  | "history"
  | "cookie"
  | "schedule"
  | "dataset"
  | "scriptPackage"
  | "mock"
  | "grpcDefinition"
  | "member"
  | "user"
  | "key"
  | "setting"
  | "backup"
  | "session"
  | "invite"
  | "other";

export interface AuditChange {
  field: string;
  /** Present only for fields that are safe to show. */
  before?: unknown;
  after?: unknown;
  /** True when the value changed but is withheld. */
  redacted?: boolean;
}

/** Columns whose values may be shown in the audit log, per entity kind (database column names). */
export const SAFE_FIELDS: Partial<Record<AuditEntityKind, readonly string[]>> = {
  workspace: ["name"],
  folder: ["name", "parent_id", "description", "sort"],
  request: ["name", "method", "url", "folder_id", "description", "sort"],
  environment: ["name", "sort"],
  variable: ["key", "scope", "type", "enabled"],
  schedule: ["name", "cron", "enabled", "folder_id", "environment_id", "dataset_id"],
  dataset: ["name", "description"],
  scriptPackage: ["name", "description", "latest_version"],
  mock: ["name", "folder_id"],
  grpcDefinition: ["name"],
  cookie: ["domain", "path", "name"],
  user: ["username", "display_name", "is_admin", "disabled", "is_service"],
  key: ["name", "scope", "rate_limit_per_minute", "expires_at"],
  member: ["role"],
};

/** Keep the host and path of a URL but drop credentials and query values. */
export function safeUrl(value: string): string {
  const [base, ...rest] = value.split("?");
  const query = rest.join("?").split("#")[0];
  const cleaned = base.replace(/\/\/[^/@]*@/, "//***@");
  if (!query) return cleaned;
  const keys = query
    .split("&")
    .filter(Boolean)
    .map((pair) => `${pair.split("=")[0]}=***`);
  return `${cleaned}?${keys.join("&")}`;
}

/** Bookkeeping columns that say nothing about what a person changed. */
const IGNORED_FIELDS = new Set(["id", "updated_at", "created_at", "workspace_id", "created_by", "sort"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clip = (v: unknown) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v);

/**
 * Compare two rows of one entity. Changed fields on the allowlist keep their values; others are listed
 * by name only. A creation has only `after`, a deletion only `before`.
 */
export function describeChange(
  kind: AuditEntityKind,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): AuditChange[] {
  const safe = new Set(SAFE_FIELDS[kind] ?? []);
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: AuditChange[] = [];
  for (const field of [...fields].sort()) {
    if (IGNORED_FIELDS.has(field)) continue;
    const b = before?.[field];
    const a = after?.[field];
    if (before && after && same(a, b)) continue;
    // A creation or deletion lists what the thing had, not every default it came with.
    const created = !before;
    const deleted = !after;
    if (created && (a === null || a === undefined || a === "")) continue;
    if (deleted && (b === null || b === undefined || b === "")) continue;
    if (!safe.has(field)) {
      if (created || deleted) continue;
      changes.push({ field, redacted: true });
      continue;
    }
    const show = (v: unknown) => clip(field === "url" && typeof v === "string" ? safeUrl(v) : v);
    changes.push({
      field,
      ...(before ? { before: show(b) } : {}),
      ...(after ? { after: show(a) } : {}),
    });
  }
  return changes;
}

const SINGULAR: Record<string, string> = {
  workspaces: "workspace",
  folders: "folder",
  requests: "request",
  environments: "environment",
  variables: "variable",
  datasets: "dataset",
  "script-packages": "scriptPackage",
  mocks: "mock",
  schedules: "schedule",
  runs: "run",
  cookies: "cookie",
  users: "user",
  tokens: "key",
  invites: "invite",
  definitions: "grpcDefinition",
};

const KIND_BY_SEGMENT: Record<string, AuditEntityKind> = {
  workspaces: "workspace",
  folders: "folder",
  requests: "request",
  environments: "environment",
  variables: "variable",
  datasets: "dataset",
  "script-packages": "scriptPackage",
  mocks: "mock",
  schedules: "schedule",
  runs: "run",
  history: "history",
  cookies: "cookie",
  users: "user",
  tokens: "key",
  invites: "invite",
  settings: "setting",
  backup: "backup",
};

/** The entity kind a route pattern such as `/api/requests/[id]` is about. */
export function entityKindOf(pattern: string): AuditEntityKind {
  const [first] = pattern.split("/").filter(Boolean).slice(1);
  return KIND_BY_SEGMENT[first ?? ""] ?? "other";
}

/**
 * A dotted action name for a route: `request.create`, `folder.update`, `mock.reset`, `workspace.delete`.
 * POST to a collection creates; POST to a sub-path is named after the sub-path.
 */
export function actionOf(method: string, pattern: string): string {
  const segments = pattern
    .split("/")
    .filter(Boolean)
    .slice(1)
    .filter((s) => s !== "[id]");
  const [head = "api", ...tail] = segments;
  const noun = SINGULAR[head] ?? head;
  const verb = method === "DELETE" ? "delete" : method === "POST" ? "create" : "update";
  if (method === "POST" && tail.length) return [noun, ...tail].join(".");
  return [noun, ...tail, verb].join(".");
}

export const AUDIT_CSV_COLUMNS = [
  "time",
  "actor",
  "actorKind",
  "workspaceId",
  "action",
  "entityKind",
  "entityId",
  "entityName",
  "revision",
  "result",
  "changes",
] as const;

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet formula injection: neutralise cells that start like a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export interface AuditRow {
  at: number;
  actorName: string;
  actorKind: string;
  workspaceId: string | null;
  action: string;
  entityKind: string;
  entityId: string | null;
  entityName: string | null;
  revision: number;
  result: string;
  changes: AuditChange[];
}

export function auditToCsv(rows: AuditRow[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const r of rows)
    lines.push(
      [
        new Date(r.at).toISOString(),
        r.actorName,
        r.actorKind,
        r.workspaceId,
        r.action,
        r.entityKind,
        r.entityId,
        r.entityName,
        r.revision,
        r.result,
        r.changes
          .map((c) =>
            c.redacted
              ? `${c.field}: changed`
              : `${c.field}: ${JSON.stringify(c.before ?? null)} -> ${JSON.stringify(c.after ?? null)}`,
          )
          .join("; "),
      ]
        .map(csvCell)
        .join(","),
    );
  return `${lines.join("\r\n")}\r\n`;
}
