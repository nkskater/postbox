import type { getDocumentation, publishDocumentation } from "@/server/documentation";
import type { PublicationInput } from "@/core/documentation/model";
/**
 * Typed browser-side client for the Postbox REST API.
 */
import type {
  CookieInfo,
  DatasetDocument,
  DatasetSummary,
  DatasetVersionInfo,
  Environment,
  FolderDef,
  RequestDef,
  ResponseExample,
  Variable,
} from "@/core/types";
import type { z } from "zod";
import type { datasetCreateSchema, datasetRevisionSchema, DatasetPackage } from "@/core/runner/datasets";
import type { exampleCommandSchema } from "@/core/schemas";
import type { RunSingleResult } from "@/server/context";
import type { TreeFolderSummary, TreeRequestSummary } from "@/server/repo";

export type ProxyResult = RunSingleResult;
export type { TreeFolderSummary, TreeRequestSummary };

const AUTH_REQUIRED_EVENT = "postbox:authentication-required";

/** The application shell owns navigation; API callers only report lost authentication. */
export function onAuthenticationRequired(listener: () => void): () => void {
  window.addEventListener(AUTH_REQUIRED_EVENT, listener);
  return () => window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
}

export interface Workspace {
  id: string;
  name: string;
}
export interface EnvironmentSummary {
  id: string;
  name: string;
}
export type SavedRequest = RequestDef & { folderId: string; workspaceId: string; sort: number };
export type SavedFolder = FolderDef & {
  parentId: string | null;
  workspaceId: string;
  sort: number;
  variables?: Variable[];
};
export interface HistorySummary {
  id: string;
  requestId: string | null;
  method: string;
  url: string;
  status: number | null;
  timeMs: number | null;
  size: number | null;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new ApiError(401, "Authentication required");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

const q = (params: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString();

export const api = {
  documentation: {
    get: (id: string) => call<ReturnType<typeof getDocumentation>>("GET", `/api/folders/${id}/documentation`),
    publish: (id: string, body: PublicationInput) =>
      call<ReturnType<typeof publishDocumentation>>("PUT", `/api/folders/${id}/documentation`, body),
    revoke: (id: string) => call<{ ok: boolean }>("DELETE", `/api/folders/${id}/documentation`),
  },
  datasets: {
    list: (workspaceId: string, signal?: AbortSignal) =>
      call<DatasetSummary[]>("GET", `/api/datasets?${q({ workspaceId })}`, undefined, signal),
    get: (
      id: string,
      options: { version?: number; includeSecrets?: boolean; previewRows?: number } = {},
      signal?: AbortSignal,
    ) =>
      call<
        DatasetDocument & {
          references: { schedules: { id: string; name: string }[]; runs: { id: string; name: string }[] };
        }
      >(
        "GET",
        `/api/datasets/${id}?${q({ version: options.version?.toString(), includeSecrets: options.includeSecrets ? "1" : undefined, previewRows: options.previewRows?.toString() })}`,
        undefined,
        signal,
      ),
    versions: (id: string, signal?: AbortSignal) =>
      call<DatasetVersionInfo[]>("GET", `/api/datasets/${id}/versions`, undefined, signal),
    create: (workspaceId: string, body: z.input<typeof datasetCreateSchema>) =>
      call<DatasetDocument>("POST", "/api/datasets", { workspaceId, ...body }),
    revise: (id: string, body: z.input<typeof datasetRevisionSchema>) =>
      call<DatasetDocument>("POST", `/api/datasets/${id}/versions`, body),
    remove: (id: string) => call("DELETE", `/api/datasets/${id}`),
    export: (id: string, version: number, includeSecrets = false) =>
      call<DatasetPackage>(
        "GET",
        `/api/datasets/${id}/export?${q({ version: String(version), includeSecrets: includeSecrets ? "1" : undefined })}`,
      ),
  },
  workspaces: {
    list: () => call<Workspace[]>("GET", "/api/workspaces"),
    create: (name: string) => call<Workspace>("POST", "/api/workspaces", { name }),
    rename: (id: string, name: string) => call<Workspace>("PATCH", `/api/workspaces/${id}`, { name }),
    remove: (id: string) => call("DELETE", `/api/workspaces/${id}`),
    tree: (id: string) =>
      call<{ folders: TreeFolderSummary[]; requests: TreeRequestSummary[] }>(
        "GET",
        `/api/workspaces/${id}/tree`,
      ),
  },
  folders: {
    get: (id: string) => call<SavedFolder>("GET", `/api/folders/${id}`),
    create: (workspaceId: string, parentId: string | null, name?: string) =>
      call<SavedFolder>("POST", "/api/folders", { workspaceId, parentId, name }),
    update: (id: string, patch: Partial<FolderDef> & { variables?: Variable[] }) =>
      call<SavedFolder>("PATCH", `/api/folders/${id}`, patch),
    remove: (id: string) => call("DELETE", `/api/folders/${id}`),
    duplicate: (id: string) => call<SavedFolder>("POST", `/api/folders/${id}/duplicate`),
  },
  requests: {
    get: (id: string) => call<SavedRequest>("GET", `/api/requests/${id}`),
    create: (workspaceId: string, folderId: string, request?: Partial<RequestDef>) =>
      call<SavedRequest>("POST", "/api/requests", { workspaceId, folderId, request }),
    update: (id: string, patch: Partial<RequestDef>) =>
      call<SavedRequest>("PATCH", `/api/requests/${id}`, patch),
    remove: (id: string) => call("DELETE", `/api/requests/${id}`),
    duplicate: (id: string) => call<SavedRequest>("POST", `/api/requests/${id}/duplicate`),
  },
  examples: {
    list: (requestId: string) =>
      call<{ examples: ResponseExample[]; version: string }>("GET", `/api/requests/${requestId}/examples`),
    change: (requestId: string, command: z.input<typeof exampleCommandSchema>) =>
      call<{ examples: ResponseExample[]; version: string; example?: ResponseExample }>(
        "POST",
        `/api/requests/${requestId}/examples`,
        command,
      ),
  },
  move: (kind: "folder" | "request", id: string, parentId: string | null, index: number) =>
    call("POST", "/api/tree/move", { kind, id, parentId, index }),
  environments: {
    list: (workspaceId: string) =>
      call<EnvironmentSummary[]>("GET", `/api/environments?${q({ workspaceId })}`),
    get: (id: string) => call<Environment & { workspaceId: string }>("GET", `/api/environments/${id}`),
    create: (workspaceId: string, name: string, variables: Variable[] = []) =>
      call<Environment>("POST", "/api/environments", { workspaceId, name, variables }),
    update: (id: string, patch: { name?: string; variables?: Variable[] }) =>
      call<Environment>("PATCH", `/api/environments/${id}`, patch),
    remove: (id: string) => call("DELETE", `/api/environments/${id}`),
    duplicate: (id: string) => call<Environment>("POST", `/api/environments/${id}/duplicate`),
  },
  variables: {
    list: (workspaceId: string, scope: "global" | "collection" | "environment", ownerId?: string | null) =>
      call<Variable[]>("GET", `/api/variables?${q({ workspaceId, scope, ownerId })}`),
    replace: (
      workspaceId: string,
      scope: "global" | "collection" | "environment",
      ownerId: string | null,
      variables: Variable[],
    ) => call<Variable[]>("PUT", "/api/variables", { workspaceId, scope, ownerId, variables }),
  },
  proxy: (
    input: {
      workspaceId: string;
      environmentId: string | null;
      folderId: string | null;
      requestId: string | null;
      request: RequestDef;
    },
    signal?: AbortSignal,
  ) => call<ProxyResult>("POST", "/api/proxy", input, signal),
  history: {
    list: (workspaceId: string) => call<HistorySummary[]>("GET", `/api/history?${q({ workspaceId })}`),
    get: (id: string) =>
      call<
        HistorySummary & {
          request: RequestDef & { folderId?: string | null };
          response: Record<string, unknown> | null;
        }
      >("GET", `/api/history/${id}`),
    clear: (workspaceId: string) => call("DELETE", `/api/history?${q({ workspaceId })}`),
  },
  cookies: {
    list: (workspaceId: string) =>
      call<(CookieInfo & { id: string })[]>("GET", `/api/cookies?${q({ workspaceId })}`),
    add: (workspaceId: string, cookie: Omit<CookieInfo, "hostOnly" | "sameSite">) =>
      call("POST", "/api/cookies", { workspaceId, cookie }),
    remove: (id: string) => call("DELETE", `/api/cookies/${id}`),
    clear: (workspaceId: string) => call("DELETE", `/api/cookies?${q({ workspaceId })}`),
  },
};
