import type { RequestDef, Variable } from "../../../../src/core/types";

export interface WorkspaceInfo {
  id: string;
  name: string;
}
export interface FolderInfo {
  id: string;
  parentId: string | null;
  name: string;
}
export interface RequestInfo {
  id: string;
  folderId: string;
  name: string;
  method: string;
}
export interface TreeInfo {
  folders: FolderInfo[];
  requests: RequestInfo[];
}
export interface EnvironmentInfo {
  id: string;
  name: string;
}
export interface EnvironmentDoc extends EnvironmentInfo {
  variables: Variable[];
}

/** A response and test outcome in the shape the editor shows, whichever way the request was sent. */
export interface ViewResult {
  name: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  timeMs: number | null;
  size: number | null;
  headers: [string, string][];
  body: string;
  tests: { name: string; passed: boolean; error?: string; skipped?: boolean }[];
  logs: { level: string; message: string }[];
  error: string | null;
  warnings: string[];
}

export interface SendContext {
  workspaceId: string;
  environmentId: string | null;
  folderId: string | null;
  requestId: string | null;
}

export type Mode = "server" | "offline";
export type { RequestDef, Variable };
