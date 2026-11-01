import { getSqlite } from "./db";
import { authorize, requireAdmin, requireScope, type WorkspaceAction } from "./authorize";
import type { Caller } from "./caller";
import { HttpError } from "./errors";

export { RESOURCE_TABLES, resourceWorkspace, type ResourceKind } from "./resources";
import { resourceWorkspace, type ResourceKind } from "./resources";
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
  "GET /api/documentation/[id]": p("public"),
  "POST /api/documentation/[id]/import": p("body", "write"),
  "GET /api/folders/[id]/documentation": p("resource", "read", "folder"),
  "PUT /api/folders/[id]/documentation": p("resource", "manage", "folder"),
  "DELETE /api/folders/[id]/documentation": p("resource", "manage", "folder"),
  "GET /api/catalog": p("public"),
  "GET /api/catalog/[id]": p("public"),
  "POST /api/catalog/[id]/import": p("body", "write"),
  "GET /api/folders/[id]/catalog": p("resource", "read", "folder"),
  "PUT /api/folders/[id]/catalog": p("resource", "manage", "folder"),
  "PATCH /api/folders/[id]/catalog": p("resource", "manage", "folder"),
  "DELETE /api/folders/[id]/catalog": p("resource", "manage", "folder"),
  "GET /api/health": p("public"),
  "GET /api/openapi.json": p("public"),
  "POST /api/auth/invite": p("public"),
  "GET /api/admin/users": p("admin"),
  "POST /api/admin/users": p("admin"),
  "GET /api/admin/security": p("admin"),
  "POST /api/admin/sessions/revoke": p("admin"),
  "GET /api/backup": p("admin"),
  "POST /api/backup": p("admin"),
  "GET /api/backup/info": p("admin"),
  "POST /api/backup/compact": p("admin"),
  "POST /api/backup/clear": p("admin"),
  "PATCH /api/admin/users/[id]": p("admin"),
  "GET /api/admin/service-accounts": p("admin"),
  "GET /api/admin/audit": p("admin"),
  "GET /api/admin/outbound/proxy": p("admin"),
  "PUT /api/admin/outbound/proxy": p("admin"),
  "DELETE /api/admin/outbound/proxy": p("admin"),
  "GET /api/admin/outbound/policy": p("admin"),
  "GET /api/admin/outbound/tls-profiles": p("admin"),
  "POST /api/admin/outbound/tls-profiles": p("admin"),
  "GET /api/admin/outbound/tls-profiles/[id]": p("admin"),
  "PATCH /api/admin/outbound/tls-profiles/[id]": p("admin"),
  "DELETE /api/admin/outbound/tls-profiles/[id]": p("admin"),
  "GET /api/admin/usage": p("admin"),
  "GET /api/admin/usage/limits": p("admin"),
  "PUT /api/admin/usage/limits": p("admin"),
  "DELETE /api/admin/usage/limits/[id]": p("admin"),
  "POST /api/admin/usage/reconcile": p("admin"),
  "GET /api/workspaces/[id]/usage": p("resource", "manage", "workspace"),
  "GET /api/workspaces/[id]/audit": p("resource", "manage", "workspace"),
  "POST /api/admin/service-accounts": p("admin"),
  "POST /api/admin/service-accounts/[id]/tokens": p("admin"),
  "DELETE /api/admin/tokens/[id]": p("admin"),
  "POST /api/admin/tokens/[id]/rotate": p("admin"),
  "POST /api/admin/users/[id]/revoke": p("admin"),
  "GET /api/invites": p("account"),
  "POST /api/invites": p("account"),
  "DELETE /api/invites/[id]": p("account"),
  "GET /api/me": p("account"),
  "POST /api/me/password": p("account"),
  "GET /api/me/tokens": p("account"),
  "POST /api/me/tokens": p("account"),
  "DELETE /api/me/tokens/[id]": p("account"),
  "POST /api/me/tokens/[id]/rotate": p("account"),
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
  "GET /api/requests/[id]/contract-validation": p("resource", "read", "request"),
  "GET /api/requests/[id]": p("resource", "read", "request"),
  "PATCH /api/requests/[id]": p("resource", "write", "request"),
  "DELETE /api/requests/[id]": p("resource", "write", "request"),
  "GET /api/requests/[id]/examples": p("resource", "read", "request"),
  "POST /api/requests/[id]/examples": p("resource", "write", "request"),
  "POST /api/requests/[id]/duplicate": p("resource", "write", "request"),
  "GET /api/webhooks": p("query", "manage"),
  "POST /api/webhooks": p("body", "manage"),
  "GET /api/webhooks/[id]": p("resource", "manage", "webhook"),
  "PATCH /api/webhooks/[id]": p("resource", "manage", "webhook"),
  "DELETE /api/webhooks/[id]": p("resource", "manage", "webhook"),
  "POST /api/webhooks/[id]/rotate": p("resource", "manage", "webhook"),
  "POST /api/webhooks/[id]/test": p("resource", "manage", "webhook"),
  "GET /api/webhooks/[id]/deliveries": p("resource", "manage", "webhook"),
  "POST /api/webhooks/[id]/replay": p("resource", "manage", "webhook"),
  "GET /api/hook-listeners": p("query", "manage"),
  "POST /api/hook-listeners": p("body", "manage"),
  "GET /api/hook-listeners/[id]": p("resource", "manage", "hookListener"),
  "PATCH /api/hook-listeners/[id]": p("resource", "manage", "hookListener"),
  "DELETE /api/hook-listeners/[id]": p("resource", "manage", "hookListener"),
  "POST /api/hook-listeners/[id]/rotate": p("resource", "manage", "hookListener"),
  "GET /api/hook-listeners/[id]/events": p("resource", "manage", "hookListener"),
  "DELETE /api/hook-listeners/[id]/events": p("resource", "manage", "hookListener"),
  "POST /api/hook-listeners/[id]/replay": p("resource", "manage", "hookListener"),
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
  "POST /api/ws": p("body", "run"),
  "POST /api/socketio": p("body", "run"),
  "POST /api/grpc": p("body", "run"),
  "POST /api/grpc/describe": p("body", "run"),
  "POST /api/grpc/reflect": p("body", "run"),
  "GET /api/grpc/definitions": p("query", "read"),
  "POST /api/grpc/definitions": p("body", "write"),
  "GET /api/grpc/definitions/[id]": p("resource", "read", "grpcDefinition"),
  "PATCH /api/grpc/definitions/[id]": p("resource", "write", "grpcDefinition"),
  "DELETE /api/grpc/definitions/[id]": p("resource", "write", "grpcDefinition"),
  // Bound to the opening user and workspace inside the handlers.
  "POST /api/grpc/[id]/send": p("account"),
  "POST /api/grpc/[id]/end": p("account"),
  "POST /api/grpc/[id]/cancel": p("account"),
  "POST /api/mqtt": p("body", "run"),
  "POST /api/mqtt/[id]/publish": p("account"),
  "POST /api/mqtt/[id]/subscribe": p("account"),
  "POST /api/mqtt/[id]/unsubscribe": p("account"),
  "POST /api/mqtt/[id]/close": p("account"),
  "POST /api/socketio/[id]/emit": p("account"),
  "POST /api/socketio/[id]/close": p("account"),
  // Bound to the opening user and workspace inside the handlers.
  "POST /api/ws/[id]/send": p("account"),
  "POST /api/ws/[id]/close": p("account"),
  "POST /api/graphql/schema": p("body", "run"),
  "POST /api/graphql/subscribe": p("body", "run"),
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
  "GET /api/mocks": p("query", "read"),
  "POST /api/mocks": p("body", "write"),
  "GET /api/mocks/[id]": p("resource", "read", "mock"),
  "PATCH /api/mocks/[id]": p("resource", "write", "mock"),
  "DELETE /api/mocks/[id]": p("resource", "write", "mock"),
  "GET /api/mocks/[id]/logs": p("resource", "read", "mock"),
  "DELETE /api/mocks/[id]/logs": p("resource", "write", "mock"),
  "POST /api/mocks/[id]/key": p("resource", "write", "mock"),
  "POST /api/mocks/[id]/refresh": p("resource", "write", "mock"),
  "POST /api/mocks/[id]/reset": p("resource", "write", "mock"),
  "GET /api/mocks/[id]/export": p("resource", "read", "mock"),
  "GET /api/script-packages": p("query", "read"),
  "POST /api/script-packages": p("body", "write"),
  "GET /api/script-packages/[id]": p("resource", "read", "scriptPackage"),
  "PATCH /api/script-packages/[id]": p("resource", "write", "scriptPackage"),
  "DELETE /api/script-packages/[id]": p("resource", "write", "scriptPackage"),
  "POST /api/script-packages/[id]/versions": p("resource", "write", "scriptPackage"),
  "POST /api/script-packages/[id]/approval": p("resource", "manage", "scriptPackage"),
  "GET /api/datasets": p("query", "read"),
  "POST /api/datasets": p("body", "write"),
  "POST /api/datasets/import": p("body", "write"),
  "GET /api/datasets/[id]": p("resource", "read", "dataset"),
  "PATCH /api/datasets/[id]": p("resource", "write", "dataset"),
  "DELETE /api/datasets/[id]": p("resource", "write", "dataset"),
  "GET /api/datasets/[id]/versions": p("resource", "read", "dataset"),
  "POST /api/datasets/[id]/versions": p("resource", "write", "dataset"),
  "GET /api/datasets/[id]/export": p("resource", "read", "dataset"),
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
    if (match) return { ...policy, pattern: path, id: match[1] ? decodeURIComponent(match[1]) : undefined };
  }
  return null;
}
const stringId = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new HttpError(400, "Workspace/resource ID required");
  return value;
};
/**
 * Sources that never reach authorize() still respect an API key's scope: creating a workspace
 * needs write; changing the caller's own keys, password or invites needs full; saving settings needs
 * write; and other per-user actions (live connection sessions, OAuth) need run.
 */
function requireSourceScope(caller: Caller, source: string, method: string, pathname: string) {
  if (source === "create") return requireScope(caller, "write");
  if (source !== "account" || ["GET", "HEAD", "OPTIONS"].includes(method)) return;
  if (pathname.startsWith("/api/me/") || pathname.startsWith("/api/invites"))
    return requireScope(caller, "full");
  if (pathname.startsWith("/api/settings")) return requireScope(caller, "write");
  requireScope(caller, "run");
}

export async function authorizeRest(
  caller: Caller,
  req: Request,
  input: () => Promise<Record<string, unknown>>,
) {
  const policy = restPolicy(req.method, new URL(req.url).pathname);
  if (!policy) throw new HttpError(403, "Route has no access policy");
  if (policy.source === "admin") return requireAdmin(caller);
  requireSourceScope(caller, policy.source, req.method, new URL(req.url).pathname);
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
  get_collection_documentation: "read",
  publish_collection_documentation: "manage",
  revoke_collection_documentation: "manage",
  import_documentation_collection: "write",
  search_catalog: "identity",
  get_catalog_entry: "identity",
  generate_catalog_sdk: "identity",
  get_collection_catalog: "read",
  publish_catalog_entry: "manage",
  update_catalog_entry: "manage",
  revoke_catalog_entry: "manage",
  import_catalog_entry: "write",
  whoami: "identity",
  list_datasets: "read",
  list_script_packages: "read",
  get_script_package: "read",
  create_script_package: "write",
  create_script_package_version: "write",
  update_script_package: "write",
  approve_script_package: "manage",
  delete_script_package: "write",

  list_mocks: "read",
  get_mock: "read",
  create_mock: "write",
  update_mock: "write",
  refresh_mock: "write",
  rotate_mock_key: "write",
  delete_mock: "write",
  export_mock: "read",
  list_mock_logs: "read",
  clear_mock_logs: "write",
  reset_mock_state: "write",

  get_dataset: "read",
  create_dataset: "write",
  update_dataset: "write",
  create_dataset_version: "write",
  delete_dataset: "write",
  import_dataset: "write",
  export_dataset: "read",
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
  list_request_examples: "read",
  validate_request_contract: "read",
  manage_request_examples: "write",
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
/**
 * Whether a tool is available in read-only MCP mode: it only reads, lists, identifies the caller
 * or runs a request or collection. Anything that creates, changes or deletes content (and any tool
 * without a policy) is not.
 */
export function isReadOnlyTool(name: string): boolean {
  const action = MCP_POLICIES[name];
  return action === "read" || action === "run" || action === "list" || action === "identity";
}

export function authorizeTool(caller: Caller, name: string, input: Record<string, unknown>) {
  const action = MCP_POLICIES[name];
  if (!action) throw new HttpError(403, "Tool has no access policy");
  if (action === "create") requireScope(caller, "write");
  if (action === "list" || action === "create" || action === "identity") return;
  const ids = new Set<string>();
  if (input.workspaceId) ids.add(stringId(input.workspaceId));
  for (const [field, kind] of [
    ["datasetId", "dataset"],
    ["mockId", "mock"],
    ["packageId", "scriptPackage"],
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
