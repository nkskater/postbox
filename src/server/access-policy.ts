import { getSqlite } from "./db";
import { authorize, requireAdmin, type WorkspaceAction } from "./authorize";
import type { Caller } from "./caller";
import { HttpError } from "./errors";

export type ResourceKind =
  "workspace" | "folder" | "request" | "environment" | "run" | "history" | "cookie" | "schedule";
const TABLES: Record<ResourceKind, string> = {
  workspace: "workspaces",
  folder: "folders",
  request: "requests",
  environment: "environments",
  run: "runs",
  history: "history",
  cookie: "cookies",
  schedule: "schedules",
};
export function resourceWorkspace(kind: ResourceKind, id: string): string {
  const row = getSqlite()
    .prepare(
      `SELECT ${kind === "workspace" ? "id" : "workspace_id"} AS workspaceId FROM ${TABLES[kind]} WHERE id = ?`,
    )
    .get(id) as { workspaceId: string } | undefined;
  if (!row) throw new HttpError(404, "Resource not found");
  return row.workspaceId;
}
type Source =
  "public" | "account" | "admin" | "list" | "create" | "body" | "query" | "resource" | "move" | "mcp";
interface Policy {
  source: Source;
  action?: WorkspaceAction;
  kind?: ResourceKind;
}
const p = (source: Source, action?: WorkspaceAction, kind?: ResourceKind): Policy => ({
  source,
  action,
  kind,
});
/** Explicit inventory: unclassified routes fail closed. Tests compare this to every route export. */
export const REST_POLICIES: Record<string, Policy> = {
  "POST /api/auth/login": p("public"),
  "POST /api/auth/logout": p("public"),
  "POST /api/auth/setup": p("public"),
  "GET /api/auth/status": p("public"),
  "GET /api/health": p("public"),
  "POST /api/auth/invite": p("public"),
  "GET /api/admin/users": p("admin"),
  "POST /api/admin/users": p("admin"),
  "PATCH /api/admin/users/[id]": p("admin"),
  "POST /api/admin/users/[id]/revoke": p("admin"),
  "GET /api/invites": p("account"),
  "POST /api/invites": p("account"),
  "DELETE /api/invites/[id]": p("account"),
  "GET /api/me": p("account"),
  "POST /api/me/password": p("account"),
  "GET /api/me/tokens": p("account"),
  "POST /api/me/tokens": p("account"),
  "DELETE /api/me/tokens/[id]": p("account"),
  "GET /api/workspaces": p("list"),
  "POST /api/workspaces": p("create"),
  "PATCH /api/workspaces/[id]": p("resource", "write", "workspace"),
  "DELETE /api/workspaces/[id]": p("resource", "manage", "workspace"),
  "GET /api/workspaces/[id]/tree": p("resource", "read", "workspace"),
  "GET /api/workspaces/[id]/members": p("resource", "manage", "workspace"),
  "PUT /api/workspaces/[id]/members": p("resource", "manage", "workspace"),
  "DELETE /api/workspaces/[id]/members": p("resource", "manage", "workspace"),
  "POST /api/folders": p("body", "write"),
  "GET /api/folders/[id]": p("resource", "read", "folder"),
  "PATCH /api/folders/[id]": p("resource", "write", "folder"),
  "DELETE /api/folders/[id]": p("resource", "write", "folder"),
  "POST /api/folders/[id]/duplicate": p("resource", "write", "folder"),
  "POST /api/requests": p("body", "write"),
  "GET /api/requests/[id]": p("resource", "read", "request"),
  "PATCH /api/requests/[id]": p("resource", "write", "request"),
  "DELETE /api/requests/[id]": p("resource", "write", "request"),
  "POST /api/requests/[id]/duplicate": p("resource", "write", "request"),
  "GET /api/environments": p("query", "read"),
  "POST /api/environments": p("body", "write"),
  "GET /api/environments/[id]": p("resource", "read", "environment"),
  "PATCH /api/environments/[id]": p("resource", "write", "environment"),
  "DELETE /api/environments/[id]": p("resource", "write", "environment"),
  "POST /api/environments/[id]/duplicate": p("resource", "write", "environment"),
  "GET /api/variables": p("query", "read"),
  "PUT /api/variables": p("body", "write"),
  "GET /api/history": p("query", "read"),
  "DELETE /api/history": p("query", "write"),
  "GET /api/history/[id]": p("resource", "read", "history"),
  "GET /api/cookies": p("query", "read"),
  "POST /api/cookies": p("body", "write"),
  "DELETE /api/cookies": p("query", "write"),
  "DELETE /api/cookies/[id]": p("resource", "write", "cookie"),
  "POST /api/proxy": p("body", "run"),
  "POST /api/oauth2/token": p("body", "run"),
  "POST /api/sse": p("body", "run"),
  "POST /api/oauth2/authorize": p("body", "run"),
  "GET /api/oauth2/tokens": p("query", "read"),
  "POST /api/oauth2/tokens/clear": p("body", "write"),
  "POST /api/oauth2/tokens/clear-all": p("body", "manage"),
  // Bound to the starting user and workspace inside the handlers.
  "GET /api/oauth2/authorize": p("account"),
  "GET /api/oauth2/callback": p("account"),
  "GET /api/codegen": p("account"),
  "POST /api/codegen": p("body", "read"),
  "POST /api/import": p("body", "write"),
  "POST /api/tree/move": p("move", "write"),
  "GET /api/export/collection/[id]": p("resource", "read", "folder"),
  "GET /api/export/environment/[id]": p("resource", "read", "environment"),
  "GET /api/runs": p("query", "read"),
  "POST /api/runs": p("body", "run"),
  "GET /api/runs/[id]": p("resource", "read", "run"),
  "DELETE /api/runs/[id]": p("resource", "write", "run"),
  "POST /api/runs/[id]/cancel": p("resource", "run", "run"),
  "GET /api/runs/[id]/export": p("resource", "read", "run"),
  "GET /api/schedules": p("query", "read"),
  "POST /api/schedules": p("body", "run"),
  "PATCH /api/schedules/[id]": p("resource", "run", "schedule"),
  "DELETE /api/schedules/[id]": p("resource", "run", "schedule"),
  "POST /api/schedules/[id]/run": p("resource", "run", "schedule"),
  "GET /api/settings": p("account"),
  "PATCH /api/settings": p("account"),
  "GET /api/settings/import": p("account"),
  "POST /api/settings/import": p("account"),
  "GET /api/mcp": p("mcp"),
  "POST /api/mcp": p("mcp"),
  "DELETE /api/mcp": p("mcp"),
  "OPTIONS /api/mcp": p("mcp"),
};
export function restPolicy(method: string, pathname: string) {
  for (const [key, policy] of Object.entries(REST_POLICIES)) {
    const [verb, path] = key.split(" ");
    if (verb !== method) continue;
    const match = new RegExp(`^${path.replaceAll("[id]", "([^/]+)")}/?$`).exec(pathname);
    if (match) return { ...policy, id: match[1] ? decodeURIComponent(match[1]) : undefined };
  }
  return null;
}
const stringId = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new HttpError(400, "Workspace/resource ID required");
  return value;
};
export async function authorizeRest(
  caller: Caller,
  req: Request,
  input: () => Promise<Record<string, unknown>>,
) {
  const policy = restPolicy(req.method, new URL(req.url).pathname);
  if (!policy) throw new HttpError(403, "Route has no access policy");
  if (policy.source === "admin") return requireAdmin(caller);
  let workspaceId: string;
  switch (policy.source) {
    case "body":
      workspaceId = stringId((await input()).workspaceId);
      break;
    case "query":
      workspaceId = stringId(new URL(req.url).searchParams.get("workspaceId"));
      break;
    case "resource":
      workspaceId = resourceWorkspace(policy.kind!, policy.id!);
      break;
    case "move": {
      const body = await input();
      workspaceId = resourceWorkspace(body.kind === "folder" ? "folder" : "request", stringId(body.id));
      break;
    }
    default:
      return;
  }
  authorize(caller, workspaceId, policy.action!);
}

export const MCP_POLICIES: Record<string, WorkspaceAction | "list" | "create" | "identity"> = {
  whoami: "identity",
  list_workspaces: "list",
  create_workspace: "create",
  rename_workspace: "write",
  delete_workspace: "manage",
  get_workspace_tree: "read",
  get_folder: "read",
  create_folder: "write",
  update_folder: "write",
  delete_folder: "write",
  duplicate_folder: "write",
  get_request: "read",
  create_request: "write",
  update_request: "write",
  delete_request: "write",
  duplicate_request: "write",
  move_tree_item: "write",
  send_request: "run",
  list_code_snippet_targets: "identity",
  generate_code_snippet: "read",
  run_collection: "run",
  list_runs: "read",
  get_run: "read",
  delete_run: "write",
  list_environments: "read",
  get_environment: "read",
  create_environment: "write",
  rename_environment: "write",
  delete_environment: "write",
  list_variables: "read",
  set_variables: "write",
  import_spec: "write",
  export_collection: "read",
  export_environment: "read",
  list_history: "read",
  get_history_entry: "read",
  clear_history: "write",
  list_cookies: "read",
  clear_cookies: "write",
};
export function authorizeTool(caller: Caller, name: string, input: Record<string, unknown>) {
  const action = MCP_POLICIES[name];
  if (!action) throw new HttpError(403, "Tool has no access policy");
  if (action === "list" || action === "create" || action === "identity") return;
  const ids = new Set<string>();
  if (input.workspaceId) ids.add(stringId(input.workspaceId));
  for (const [field, kind] of [
    ["folderId", "folder"],
    ["requestId", "request"],
    ["environmentId", "environment"],
    ["runId", "run"],
    ["historyId", "history"],
    ["cookieId", "cookie"],
  ] as const) {
    if (input[field]) ids.add(resourceWorkspace(kind, stringId(input[field])));
  }
  if (name === "move_tree_item")
    ids.add(resourceWorkspace(input.kind === "folder" ? "folder" : "request", stringId(input.id)));
  if (!ids.size) {
    const rows = getSqlite().prepare("SELECT id FROM workspaces ORDER BY created_at").all() as {
      id: string;
    }[];
    const accessible = rows.find((r) => {
      try {
        authorize(caller, r.id, "read");
        return true;
      } catch {
        return false;
      }
    });
    if (!accessible) throw new HttpError(404, "Workspace not found");
    ids.add(accessible.id);
  }
  for (const id of ids) authorize(caller, id, action);
}
