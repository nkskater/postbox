/**
 * Bridges the core executor with persistence: loads variable scopes, cookie jar
 * and inherited folder settings from SQLite, runs the request, then persists
 * variable changes, cookies and history.
 */
import type { FolderDef, RequestDef, Variable } from "@/core/types";
import { execute, type ExecuteResult, type SavedRequestResolver } from "@/core/executor";
import { CookieJarStore } from "@/core/http/cookies";
import { HostPolicy } from "@/core/http/policy";
import {
  emptyScopes,
  variablesToRecord,
  redactStoredValue,
  type VariableScopes,
} from "@/core/variables/resolver";
import type { OAuth2Token } from "@/core/http/auth";
import * as repo from "./repo";
import { executionSettings } from "./execution-settings";
import { authCredentialValues, credentialRedactionValues, sensitiveFieldValues } from "@/core/retention";

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
  secretKeys: { globals: string[]; environment: string[]; collection: string[] };
}

const secretValues = (...lists: Variable[][]) =>
  lists
    .flat()
    .filter((v) => v.type === "secret" && v.enabled && v.value)
    .map((v) => v.value);

export function loadScopes(
  workspaceId: string,
  environmentId: string | null,
  collectionId: string | null,
): ScopeContext {
  repo.requireWorkspace(workspaceId);
  if (environmentId) repo.requireEnvironmentIn(workspaceId, environmentId);
  if (collectionId) repo.requireCollectionIn(workspaceId, collectionId);
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
    secretKeys: {
      globals: globals.filter((v) => v.type === "secret" && v.enabled).map((v) => v.key),
      environment: env.filter((v) => v.type === "secret" && v.enabled).map((v) => v.key),
      collection: col.filter((v) => v.type === "secret" && v.enabled).map((v) => v.key),
    },
  };
}

/** Persist script-made variable changes; returns warnings (e.g. no active environment). */
export function persistScopes(ctx: ScopeContext, after: VariableScopes): string[] {
  const warnings: string[] = [];
  repo.persistScopeDiff(ctx.workspaceId, "global", null, ctx.scopes.globals, after.globals);
  if (ctx.environmentId)
    repo.persistScopeDiff(
      ctx.workspaceId,
      "environment",
      ctx.environmentId,
      ctx.scopes.environment,
      after.environment,
    );
  else if (JSON.stringify(after.environment) !== JSON.stringify(ctx.scopes.environment))
    warnings.push(
      "A script set environment variables but no environment is selected; the changes were discarded.",
    );
  if (ctx.collectionId)
    repo.persistScopeDiff(
      ctx.workspaceId,
      "collection",
      ctx.collectionId,
      ctx.scopes.collection,
      after.collection,
    );
  return warnings;
}

/** Include both old and script-updated values of declared secret variables. */
export function persistenceSecrets(ctx: ScopeContext, after: VariableScopes): string[] {
  const values = [...ctx.secrets];
  for (const scope of ["globals", "environment", "collection"] as const) {
    for (const key of ctx.secretKeys[scope]) if (after[scope][key]) values.push(after[scope][key]);
  }
  return [...new Set(values)];
}

/** Save only to the original auth owner, without overwriting edits made during the request. */
export function persistOAuth2Token(
  workspaceId: string,
  request: RequestDef,
  ancestors: FolderDef[],
  token?: OAuth2Token,
  requestId?: string | null,
) {
  if (!token) return;
  const folder =
    request.auth.type === "inherit"
      ? [...ancestors].reverse().find((item) => item.auth.type !== "inherit")
      : undefined;
  const original = folder?.auth ?? request.auth;
  if (original.type !== "oauth2" || original.oauth2.grantType === "manual") return;
  const owner = folder ? repo.getFolder(folder.id) : requestId ? repo.getRequest(requestId) : null;
  if (!owner || owner.workspaceId !== workspaceId || JSON.stringify(owner.auth) !== JSON.stringify(original))
    return;
  const auth = {
    ...original,
    oauth2: {
      ...original.oauth2,
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      tokenContext: token.contextKey,
    },
  };
  if (JSON.stringify(owner.auth) === JSON.stringify(auth)) return;
  if (folder) repo.updateFolder(owner.id, { auth });
  else repo.updateRequest(owner.id, { auth });
}

/** Resolve references only inside the already-authorized workspace. */
export function savedRequestResolver(
  workspaceId: string,
  environmentId: string | null,
  secrets: string[],
  persistVariables = true,
): SavedRequestResolver {
  return (id) => {
    const request = repo.requireRequestIn(workspaceId, id);
    const ancestors = repo.getFolderChain(request.folderId);
    const ctx = loadScopes(workspaceId, environmentId, ancestors[0]?.id ?? null);
    const auth =
      request.auth.type === "inherit"
        ? [...ancestors].reverse().find((folder) => folder.auth.type !== "inherit")?.auth
        : request.auth;
    return {
      request,
      ancestors,
      collectionVariables: ctx.scopes.collection,
      secrets: [
        ...ctx.secrets,
        ...(auth ? authCredentialValues(auth) : []),
        ...sensitiveFieldValues(request),
      ],
      onExecution: (result) => {
        for (const secret of persistenceSecrets(ctx, result.scopes))
          if (!secrets.includes(secret)) secrets.push(secret);
        if (persistVariables && ctx.collectionId)
          repo.persistScopeDiff(
            workspaceId,
            "collection",
            ctx.collectionId,
            ctx.scopes.collection,
            result.scopes.collection,
          );
        persistOAuth2Token(workspaceId, request, ancestors, result.oauth2Token, request.id);
      },
    };
  };
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
  // Inherited auth, headers and scripts must come from the caller's workspace.
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.requestId) repo.requireRequestIn(input.workspaceId, input.requestId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const collectionId = chain[0]?.id ?? null;
  const ctx = loadScopes(input.workspaceId, input.environmentId, collectionId);
  const jar =
    input.request.settings?.useCookieJar === false
      ? undefined
      : new CookieJarStore(repo.listCookies(input.workspaceId));

  const result = await execute({
    request: input.request,
    resolveRequest: savedRequestResolver(input.workspaceId, input.environmentId, ctx.secrets),
    ancestors: chain,
    scopes: ctx.scopes,
    cookieJar: jar,
    policy: getPolicy(),
    secrets: ctx.secrets,
    signal: input.signal,
    oauth2CacheScope: input.workspaceId,
    ...executionSettings(),
  });

  persistOAuth2Token(input.workspaceId, input.request, chain, result.oauth2Token, input.requestId);
  const effectiveAuth =
    input.request.auth.type === "inherit"
      ? [...chain].reverse().find((folder) => folder.auth.type !== "inherit")?.auth
      : input.request.auth;
  const credentialNames =
    /authorization|cookie|token|password|secret|api[-_]?key|session|credential|jwt|signature|sig|code/i;
  const queryCredentialValues = (url: string) => {
    try {
      return [...new URL(url).searchParams].flatMap(([name, value]) =>
        credentialNames.test(name) ? [value] : [],
      );
    } catch {
      return [];
    }
  };
  const secrets = credentialRedactionValues([
    ...persistenceSecrets(ctx, result.scopes),
    ...(effectiveAuth ? authCredentialValues(effectiveAuth) : []),
    result.oauth2Token?.accessToken ?? "",
    ...sensitiveFieldValues(input.request),
    ...queryCredentialValues(input.request.url),
    ...(result.response?.headers ?? []).flatMap(([name, value]) =>
      credentialNames.test(name) ? [value] : [],
    ),
    ...queryCredentialValues(result.response?.url ?? ""),
    ...sensitiveFieldValues(result.response?.bodyText ?? ""),
  ]);
  const warnings = persistScopes(ctx, result.scopes);
  if (jar) repo.saveCookies(input.workspaceId, jar.getChanges());

  let historyId: string | undefined;
  if (input.saveHistory !== false && !result.skipped) {
    const entry = redactStoredValue(
      {
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
      },
      secrets,
    );
    // Stable identifiers are references, not payload strings; short secret values can overlap them.
    entry.workspaceId = input.workspaceId;
    entry.requestId = input.requestId ?? null;
    entry.request = { ...entry.request, id: input.request.id, folderId: input.folderId };
    historyId = repo.addHistory(entry);
  }
  return { ...result, warnings, historyId };
}
