/**
 * Bridges the core executor with persistence: loads variable scopes, cookie jar
 * and inherited folder settings from SQLite, runs the request, then persists
 * variable changes, cookies and history.
 */
import type { FolderDef, RequestDef, Variable } from "@/core/types";
import { execute, type ExecuteResult } from "@/core/executor";
import { CookieJarStore } from "@/core/http/cookies";
import { HostPolicy } from "@/core/http/policy";
import { emptyScopes, variablesToRecord, type VariableScopes } from "@/core/variables/resolver";
import * as repo from "./repo";

let policy: HostPolicy | null = null;
/** Host policy from PROXY_ALLOW_HOSTS / PROXY_DENY_HOSTS (parsed once). */
export function getPolicy(): HostPolicy {
  return (policy ??= HostPolicy.fromEnv());
}

export interface ScopeContext {
  workspaceId: string;
  environmentId: string | null;
  collectionId: string | null;
  scopes: VariableScopes;
  secrets: string[];
}

const secretValues = (...lists: Variable[][]) =>
  lists.flat().filter((v) => v.type === "secret" && v.enabled && v.value).map((v) => v.value);

export function loadScopes(workspaceId: string, environmentId: string | null, collectionId: string | null): ScopeContext {
  const globals = repo.listVariables(workspaceId, "global", null);
  const env = environmentId ? repo.listVariables(workspaceId, "environment", environmentId) : [];
  const col = collectionId ? repo.listVariables(workspaceId, "collection", collectionId) : [];
  return {
    workspaceId,
    environmentId,
    collectionId,
    scopes: {
      ...emptyScopes(),
      globals: variablesToRecord(globals),
      environment: variablesToRecord(env),
      collection: variablesToRecord(col),
    },
    secrets: secretValues(globals, env, col),
  };
}

/** Persist script-made variable changes; returns warnings (e.g. no active environment). */
export function persistScopes(ctx: ScopeContext, after: VariableScopes): string[] {
  const warnings: string[] = [];
  repo.persistScopeDiff(ctx.workspaceId, "global", null, ctx.scopes.globals, after.globals);
  if (ctx.environmentId) repo.persistScopeDiff(ctx.workspaceId, "environment", ctx.environmentId, ctx.scopes.environment, after.environment);
  else if (JSON.stringify(after.environment) !== JSON.stringify(ctx.scopes.environment))
    warnings.push("A script set environment variables but no environment is selected; the changes were discarded.");
  if (ctx.collectionId) repo.persistScopeDiff(ctx.workspaceId, "collection", ctx.collectionId, ctx.scopes.collection, after.collection);
  return warnings;
}

export interface RunSingleInput {
  workspaceId: string;
  environmentId: string | null;
  request: RequestDef;
  /** Folder containing the request (saved or "Save to" target); used for inheritance. */
  folderId: string | null;
  requestId?: string | null;
  saveHistory?: boolean;
  signal?: AbortSignal;
}

export interface RunSingleResult extends ExecuteResult {
  warnings: string[];
  historyId?: string;
}

/** Execute one request with full persistence (used by /api/proxy and MCP). */
export async function runSingleRequest(input: RunSingleInput): Promise<RunSingleResult> {
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const collectionId = chain[0]?.id ?? null;
  const ctx = loadScopes(input.workspaceId, input.environmentId, collectionId);
  const jar = new CookieJarStore(repo.listCookies(input.workspaceId));

  const result = await execute({
    request: input.request,
    ancestors: chain,
    scopes: ctx.scopes,
    cookieJar: jar,
    policy: getPolicy(),
    secrets: ctx.secrets,
    signal: input.signal,
  });

  const warnings = persistScopes(ctx, result.scopes);
  if (input.request.settings?.useCookieJar !== false) repo.saveCookies(input.workspaceId, await jar.list());

  let historyId: string | undefined;
  if (input.saveHistory !== false && !result.skipped) {
    historyId = repo.addHistory({
      workspaceId: input.workspaceId,
      requestId: input.requestId ?? null,
      method: input.request.method,
      url: input.request.url,
      status: result.response?.status ?? null,
      timeMs: result.response ? Math.round(result.response.timings.total) : null,
      size: result.response?.size ?? null,
      request: { ...input.request, folderId: input.folderId } as unknown as Record<string, unknown>,
      response: result.response
        ? {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
            body: result.response.isBinary ? "" : result.response.bodyText.slice(0, 256 * 1024),
            isBinary: result.response.isBinary,
            timings: result.response.timings,
            size: result.response.size,
          }
        : { error: result.error },
    });
  }
  return { ...result, warnings, historyId };
}
