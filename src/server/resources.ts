import { getSqlite } from "./db";
import { HttpError } from "./errors";

export type ResourceKind =
  | "workspace"
  | "folder"
  | "request"
  | "environment"
  | "run"
  | "history"
  | "cookie"
  | "schedule"
  | "dataset"
  | "mock"
  | "grpcDefinition"
  | "scriptPackage";
export const RESOURCE_TABLES: Record<ResourceKind, string> = {
  workspace: "workspaces",
  folder: "folders",
  request: "requests",
  environment: "environments",
  run: "runs",
  history: "history",
  cookie: "cookies",
  schedule: "schedules",
  dataset: "datasets",
  mock: "mock_servers",
  grpcDefinition: "grpc_definitions",
  scriptPackage: "script_packages",
};
export function resourceWorkspace(kind: ResourceKind, id: string): string {
  const row = getSqlite()
    .prepare(
      `SELECT ${kind === "workspace" ? "id" : "workspace_id"} AS workspaceId FROM ${RESOURCE_TABLES[kind]} WHERE id = ?`,
    )
    .get(id) as { workspaceId: string } | undefined;
  if (!row) throw new HttpError(404, "Resource not found");
  return row.workspaceId;
}
