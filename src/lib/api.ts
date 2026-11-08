import type * as telemetry from "@/server/telemetry";
import type { TelemetryConfig, TelemetryQuery } from "@/core/telemetry/model";
import type * as scorecards from "@/server/scorecards";
import type * as governance from "@/server/governance";
import type * as specificationSync from "@/server/specification-sync";
import type * as specifications from "@/server/specifications";
import type { SpecificationAnalysis } from "@/core/specifications/model";
import type { listMonitors, getMonitor, monitorInput, monitorPatch } from "@/server/monitors";
import type { getFolderCatalog, searchCatalog, getCatalogEntry, publishCatalog } from "@/server/catalog";
import type { CatalogPublishInput, CatalogMetadataInput, CatalogSearchInput } from "@/core/catalog/model";
import type * as graphServer from "@/server/graph";
import type * as discussions from "@/server/comments";
import type * as shared from "@/server/dependencies";
import type * as forkServer from "@/server/forks";
import type * as repositoryServer from "@/server/repository";
import type { ConflictStrategy, DependencyKind } from "@/core/dependencies/model";
import type { CommentTarget } from "@/core/comments/model";
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

const COMMENT_ROUTES: Record<CommentTarget, string> = {
  request: "requests",
  folder: "folders",
  specification: "specifications",
  mergeRequest: "merge-requests",
};
export const api = {
  telemetry: {
    sources: (workspaceId: string) =>
      call<ReturnType<typeof telemetry.listTelemetrySources>>(
        "GET",
        `/api/telemetry/sources?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    create: (workspaceId: string, config: TelemetryConfig) =>
      call<ReturnType<typeof telemetry.createTelemetrySource>>("POST", "/api/telemetry/sources", {
        workspaceId,
        config,
      }),
    save: (id: string, expectedRevision: number, config: TelemetryConfig) =>
      call<ReturnType<typeof telemetry.saveTelemetrySource>>("PATCH", `/api/telemetry/sources/${id}`, {
        expectedRevision,
        config,
      }),
    rotate: (id: string, expectedRevision: number) =>
      call<ReturnType<typeof telemetry.rotateTelemetrySource>>(
        "POST",
        `/api/telemetry/sources/${id}/rotate`,
        { expectedRevision },
      ),
    delete: (id: string) => call<{ ok: boolean }>("DELETE", `/api/telemetry/sources/${id}`),
    purge: (id: string) => call<{ deleted: number }>("DELETE", `/api/telemetry/sources/${id}/observations`),
    metrics: (workspaceId: string, query: TelemetryQuery) =>
      call<ReturnType<typeof telemetry.getTelemetryMetrics>>(
        "GET",
        `/api/telemetry/metrics?${new URLSearchParams(
          Object.entries({ workspaceId, ...query })
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        )}`,
      ),
    endpoint: (workspaceId: string, id: string, query: TelemetryQuery) =>
      call<ReturnType<typeof telemetry.getTelemetryEndpoint>>(
        "GET",
        `/api/telemetry/endpoints/${id}?${new URLSearchParams(
          Object.entries({ workspaceId, ...query })
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        )}`,
      ),
  },
  scorecards: {
    list: (workspaceId: string) =>
      call<ReturnType<typeof scorecards.listScorecards>>(
        "GET",
        `/api/scorecards?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    create: (body: Parameters<typeof scorecards.createScorecard>[0]) =>
      call<ReturnType<typeof scorecards.getScorecard>>("POST", "/api/scorecards", body),
    get: (id: string, version?: number) =>
      call<ReturnType<typeof scorecards.getScorecard>>(
        "GET",
        `/api/scorecards/${id}${version ? `?version=${version}` : ""}`,
      ),
    save: (id: string, body: Parameters<typeof scorecards.saveScorecard>[1]) =>
      call<ReturnType<typeof scorecards.getScorecard>>("PATCH", `/api/scorecards/${id}`, body),
    delete: (id: string) => call<{ ok: boolean }>("DELETE", `/api/scorecards/${id}`),
    sources: (id: string) =>
      call<ReturnType<typeof scorecards.scorecardSources>>("GET", `/api/scorecards/${id}/sources`),
    bind: (id: string, body: Parameters<typeof scorecards.bindQualityService>[1]) =>
      call<ReturnType<typeof scorecards.bindQualityService>>("PUT", `/api/scorecards/${id}/bindings`, body),
    unbind: (id: string, bindingId: string) =>
      call<{ ok: boolean }>("DELETE", `/api/scorecards/${id}/bindings/${bindingId}`),
    preview: (id: string, body: Parameters<typeof scorecards.previewScorecard>[1] = {}) =>
      call<ReturnType<typeof scorecards.previewScorecard>>("POST", `/api/scorecards/${id}/preview`, body),
    run: (id: string, body: Parameters<typeof scorecards.saveQualityReport>[1] = {}) =>
      call<ReturnType<typeof scorecards.saveQualityReport>>("POST", `/api/scorecards/${id}/reports`, body),
    reports: (id: string, filters: Record<string, string> = {}) =>
      call<ReturnType<typeof scorecards.listQualityReports>>(
        "GET",
        `/api/scorecards/${id}/reports?${new URLSearchParams(filters)}`,
      ),
    report: (id: string, reportId: string, filters: Record<string, string> = {}) =>
      call<ReturnType<typeof scorecards.getQualityReport>>(
        "GET",
        `/api/scorecards/${id}/reports/${reportId}?${new URLSearchParams(filters)}`,
      ),
    compare: (id: string, body: Parameters<typeof scorecards.compareQualityReports>[1]) =>
      call<ReturnType<typeof scorecards.compareQualityReports>>(
        "POST",
        `/api/scorecards/${id}/compare`,
        body,
      ),
  },
  governance: {
    list: (workspaceId: string) =>
      call<ReturnType<typeof governance.listRuleSets>>(
        "GET",
        `/api/governance/rulesets?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    get: (id: string, version?: number) =>
      call<ReturnType<typeof governance.getRuleSet>>(
        "GET",
        `/api/governance/rulesets/${id}${version ? `?version=${version}` : ""}`,
      ),
    create: (input: Parameters<typeof governance.createRuleSet>[0]) =>
      call<ReturnType<typeof governance.getRuleSet>>("POST", "/api/governance/rulesets", input),
    save: (id: string, input: Parameters<typeof governance.saveRuleSet>[1]) =>
      call<ReturnType<typeof governance.getRuleSet>>("PATCH", `/api/governance/rulesets/${id}`, input),
    delete: (id: string) => call<{ ok: boolean }>("DELETE", `/api/governance/rulesets/${id}`),
    lint: (input: Parameters<typeof governance.lintDraft>[0]) =>
      call<ReturnType<typeof governance.lintDraft>>("POST", "/api/governance/lint", input),
    binding: (id: string) =>
      call<ReturnType<typeof governance.getSpecificationGovernance>>(
        "GET",
        `/api/specifications/${id}/governance`,
      ),
    bind: (id: string, input: Parameters<typeof governance.bindGovernance>[1]) =>
      call<ReturnType<typeof governance.getSpecificationGovernance>>(
        "PUT",
        `/api/specifications/${id}/governance`,
        input,
      ),
    unbind: (id: string) => call<{ ok: boolean }>("DELETE", `/api/specifications/${id}/governance`),
    preview: (id: string, version?: number) =>
      call<ReturnType<typeof governance.previewGovernance>>(
        "POST",
        `/api/specifications/${id}/governance/lint`,
        version ? { version } : {},
      ),
    run: (id: string, version?: number) =>
      call<ReturnType<typeof governance.saveGovernanceReport>>(
        "POST",
        `/api/specifications/${id}/governance/reports`,
        version ? { version } : {},
      ),
    reports: (id: string) =>
      call<ReturnType<typeof governance.listGovernanceReports>>(
        "GET",
        `/api/specifications/${id}/governance/reports`,
      ),
    report: (id: string, reportId: string) =>
      call<ReturnType<typeof governance.getGovernanceReport>>(
        "GET",
        `/api/specifications/${id}/governance/reports/${reportId}`,
      ),
  },
  specificationSync: {
    link: (folderId: string) =>
      call<ReturnType<typeof specificationSync.getCollectionSpecification>>(
        "GET",
        `/api/folders/${folderId}/specification`,
      ),
    generateSpecification: (
      folderId: string,
      input: Parameters<typeof specificationSync.generateSpecification>[1] = {},
    ) =>
      call<ReturnType<typeof specificationSync.generateSpecification>>(
        "POST",
        `/api/folders/${folderId}/specification`,
        input,
      ),
    unlink: (folderId: string) => call<{ ok: boolean }>("DELETE", `/api/folders/${folderId}/specification`),
    collections: (id: string) =>
      call<ReturnType<typeof specificationSync.listSpecificationCollections>>(
        "GET",
        `/api/specifications/${id}/collections`,
      ),
    generateCollection: (
      id: string,
      input: Parameters<typeof specificationSync.generateCollection>[1] = {},
    ) =>
      call<Awaited<ReturnType<typeof specificationSync.generateCollection>>>(
        "POST",
        `/api/specifications/${id}/collections`,
        input,
      ),
    preview: (id: string, input: Parameters<typeof specificationSync.previewSpecificationSync>[1]) =>
      call<Awaited<ReturnType<typeof specificationSync.previewSpecificationSync>>>(
        "POST",
        `/api/specifications/${id}/sync/preview`,
        input,
      ),
    apply: (id: string, input: Parameters<typeof specificationSync.applySpecificationSync>[1]) =>
      call<Awaited<ReturnType<typeof specificationSync.applySpecificationSync>>>(
        "POST",
        `/api/specifications/${id}/sync/apply`,
        input,
      ),
  },
  specifications: {
    list: (workspaceId: string) =>
      call<ReturnType<typeof specifications.listSpecifications>>(
        "GET",
        `/api/specifications?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    get: (id: string, version?: number) =>
      call<ReturnType<typeof specifications.getSpecification>>(
        "GET",
        `/api/specifications/${id}${version ? `?version=${version}` : ""}`,
      ),
    create: (input: Parameters<typeof specifications.createSpecification>[0]) =>
      call<ReturnType<typeof specifications.getSpecification>>("POST", "/api/specifications", input),
    save: (id: string, input: Parameters<typeof specifications.saveSpecification>[1]) =>
      call<ReturnType<typeof specifications.getSpecification>>("PATCH", `/api/specifications/${id}`, input),
    delete: (id: string) => call<{ ok: boolean }>("DELETE", `/api/specifications/${id}`),
    validate: (input: Parameters<typeof specifications.validateSpecification>[0]) =>
      call<SpecificationAnalysis>("POST", "/api/specifications/validate", input),
  },
  monitors: {
    list: (workspaceId: string, signal?: AbortSignal) =>
      call<ReturnType<typeof listMonitors>>(
        "GET",
        `/api/monitors?workspaceId=${encodeURIComponent(workspaceId)}`,
        undefined,
        signal,
      ),
    get: (id: string, hours = 168, signal?: AbortSignal) =>
      call<ReturnType<typeof getMonitor>>("GET", `/api/monitors/${id}?hours=${hours}`, undefined, signal),
    create: (input: z.input<typeof monitorInput>) =>
      call<ReturnType<typeof getMonitor>>("POST", "/api/monitors", input),
    update: (id: string, input: z.input<typeof monitorPatch>) =>
      call<ReturnType<typeof getMonitor>>("PATCH", `/api/monitors/${id}`, input),
    run: (id: string) => call<{ runId: string }>("POST", `/api/monitors/${id}/run`),
    delete: (id: string) => call<{ ok: boolean }>("DELETE", `/api/monitors/${id}`),
    retry: (id: string, deliveryId: string) =>
      call<{ ok: boolean }>("POST", `/api/monitors/${id}/retry-email`, { deliveryId }),
  },
  repository: {
    files: (kind: "collection" | "environment" | "specification", id: string) => {
      const route = { collection: "folders", environment: "environments", specification: "specifications" }[
        kind
      ];
      return call<
        | ReturnType<typeof repositoryServer.exportFiles>
        | ReturnType<typeof repositoryServer.exportEnvironmentFiles>
        | ReturnType<typeof repositoryServer.exportSpecificationFiles>
      >("GET", `/api/${route}/${id}/files`);
    },
  },
  forks: {
    listOf: (id: string, kind: "collection" | "specification" = "collection") =>
      call<ReturnType<typeof forkServer.listForksOf>>(
        "GET",
        `/api/${kind === "specification" ? "specifications" : "folders"}/${id}/forks`,
      ),
    create: (
      id: string,
      workspaceId: string,
      name?: string,
      kind: "collection" | "specification" = "collection",
    ) =>
      call<ReturnType<typeof forkServer.forkCollection>>(
        "POST",
        `/api/${kind === "specification" ? "specifications" : "folders"}/${id}/forks`,
        { workspaceId, name },
      ),
    list: (workspaceId: string) =>
      call<ReturnType<typeof forkServer.listForks>>("GET", `/api/forks?${q({ workspaceId })}`),
    previewSync: (id: string) =>
      call<ReturnType<typeof forkServer.previewSync>>("GET", `/api/forks/${id}/sync`),
    sync: (id: string, strategy: ConflictStrategy) =>
      call<ReturnType<typeof forkServer.syncFork>>("POST", `/api/forks/${id}/sync`, { strategy }),
    remove: (id: string, deleteCopy = false) =>
      call<{ removed: boolean }>("DELETE", `/api/forks/${id}${deleteCopy ? "?deleteCopy=1" : ""}`),
    propose: (id: string, title: string, description: string) =>
      call<ReturnType<typeof forkServer.mergeRequestView>>("POST", `/api/forks/${id}/merge-requests`, {
        title,
        description,
      }),
  },
  mergeRequests: {
    list: (workspaceId: string, status?: string) =>
      call<ReturnType<typeof forkServer.listMergeRequests>>(
        "GET",
        `/api/merge-requests?${q({ workspaceId, status })}`,
      ),
    get: (id: string) =>
      call<ReturnType<typeof forkServer.mergeRequestView>>("GET", `/api/merge-requests/${id}`),
    review: (id: string, decision: "approve" | "reject", note: string) =>
      call<ReturnType<typeof forkServer.mergeRequestView>>("POST", `/api/merge-requests/${id}/reviews`, {
        decision,
        note,
      }),
    merge: (id: string) =>
      call<ReturnType<typeof forkServer.mergeMergeRequest>>("POST", `/api/merge-requests/${id}/merge`),
    close: (id: string, note: string) =>
      call<ReturnType<typeof forkServer.mergeRequestView>>("POST", `/api/merge-requests/${id}/close`, {
        note,
      }),
  },
  dependencies: {
    releases: (id: string, kind: DependencyKind = "collection") =>
      call<ReturnType<typeof shared.listReleases>>(
        "GET",
        `/api/${kind === "environment" ? "environments" : "folders"}/${id}/releases`,
      ),
    publish: (
      id: string,
      input: { version: string; notes?: string; visibility: "workspace" | "instance" },
      kind: DependencyKind = "collection",
    ) =>
      call<ReturnType<typeof shared.publishRelease>>(
        "POST",
        `/api/${kind === "environment" ? "environments" : "folders"}/${id}/releases`,
        input,
      ),
    revoke: (releaseId: string, reason: string) =>
      call<ReturnType<typeof shared.revokeRelease>>("POST", `/api/dependency-releases/${releaseId}/revoke`, {
        reason,
      }),
    browse: (workspaceId: string) =>
      call<ReturnType<typeof shared.browseReleases>>("GET", `/api/dependency-releases?${q({ workspaceId })}`),
    list: (workspaceId: string) =>
      call<ReturnType<typeof shared.listInstalls>>("GET", `/api/dependencies?${q({ workspaceId })}`),
    install: (workspaceId: string, releaseId: string) =>
      call<ReturnType<typeof shared.installRelease>>("POST", "/api/dependencies", { workspaceId, releaseId }),
    preview: (id: string, releaseId?: string) =>
      call<ReturnType<typeof shared.previewUpdate>>(
        "GET",
        `/api/dependencies/${id}/preview${releaseId ? `?${q({ releaseId })}` : ""}`,
      ),
    update: (id: string, strategy: ConflictStrategy, releaseId?: string) =>
      call<ReturnType<typeof shared.updateInstall>>("POST", `/api/dependencies/${id}/update`, {
        strategy,
        releaseId,
      }),
    remove: (id: string, deleteCopy = false) =>
      call<{ removed: boolean }>("DELETE", `/api/dependencies/${id}${deleteCopy ? "?deleteCopy=1" : ""}`),
  },
  comments: {
    list: (kind: CommentTarget, id: string) =>
      call<ReturnType<typeof discussions.listComments>>("GET", `/api/${COMMENT_ROUTES[kind]}/${id}/comments`),
    add: (kind: CommentTarget, id: string, body: string, parentId: string | null = null) =>
      call<ReturnType<typeof discussions.createComment>>(
        "POST",
        `/api/${COMMENT_ROUTES[kind]}/${id}/comments`,
        {
          body,
          parentId,
        },
      ),
    edit: (id: string, body: string) =>
      call<ReturnType<typeof discussions.editComment>>("PATCH", `/api/comments/${id}`, { body }),
    resolve: (id: string, resolved: boolean) =>
      call<ReturnType<typeof discussions.setResolved>>("PUT", `/api/comments/${id}/resolution`, { resolved }),
    remove: (id: string) => call<{ deleted: number }>("DELETE", `/api/comments/${id}`),
    counts: (workspaceId: string) =>
      call<Record<string, number>>("GET", `/api/comments/counts?${q({ workspaceId })}`),
    mentionable: (workspaceId: string) =>
      call<ReturnType<typeof discussions.listMentionable>>(
        "GET",
        `/api/comments/mentionable?${q({ workspaceId })}`,
      ),
    notifications: (unread = false) =>
      call<ReturnType<typeof discussions.listNotifications>>(
        "GET",
        `/api/notifications${unread ? "?unread=1" : ""}`,
      ),
    markRead: (ids?: string[]) => call<{ updated: number }>("POST", "/api/notifications/read", { ids }),
  },
  graph: {
    overview: (workspaceId: string) =>
      call<ReturnType<typeof graphServer.graphOverview>>("GET", `/api/graph?${q({ workspaceId })}`),
    search: (workspaceId: string, query: string, kind?: string) =>
      call<ReturnType<typeof graphServer.searchGraph>>(
        "GET",
        `/api/graph/search?${q({ workspaceId, query, kind })}`,
      ),
    traverse: (params: { workspaceId: string; node: string; direction: string; depth: number }) =>
      call<ReturnType<typeof graphServer.traverseGraph>>(
        "GET",
        `/api/graph/traverse?${q({ ...params, depth: String(params.depth) })}`,
      ),
    refresh: (workspaceId: string) =>
      call<ReturnType<typeof graphServer.refreshGraph>>("POST", "/api/graph/refresh", { workspaceId }),
    connect: (workspaceId: string, sourceId: string, connected: boolean) =>
      call<unknown>("PATCH", "/api/graph/sources", { workspaceId, sourceId, connected }),
  },
  catalog: {
    managed: (id: string) => call<ReturnType<typeof getFolderCatalog>>("GET", `/api/folders/${id}/catalog`),
    publish: (id: string, body: CatalogPublishInput) =>
      call<ReturnType<typeof publishCatalog>>("PUT", `/api/folders/${id}/catalog`, body),
    update: (id: string, body: CatalogMetadataInput) =>
      call<ReturnType<typeof publishCatalog>>("PATCH", `/api/folders/${id}/catalog`, body),
    revoke: (id: string) => call<{ ok: boolean }>("DELETE", `/api/folders/${id}/catalog`),
    search: (input: CatalogSearchInput = {}, signal?: AbortSignal) =>
      call<ReturnType<typeof searchCatalog>>(
        "GET",
        `/api/catalog?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(input)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          ),
        )}`,
        undefined,
        signal,
      ),
    get: (id: string, version?: number) =>
      call<ReturnType<typeof getCatalogEntry>>(
        "GET",
        `/api/catalog/${id}${version ? `?version=${version}` : ""}`,
      ),
  },
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
