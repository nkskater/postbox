import type { ModuleSnapshot } from "./packages/model";
import { redactStoredValue } from "./variables/resolver";
import { credentialRedactionValues, redactSensitiveFields } from "./retention";
import { renderVisualization } from "./visualizer/render";
import type { Visualization, VisualizerResult } from "./visualizer/model";
/**
 * The single-request execution pipeline shared by /api/proxy, the collection
 * runner, the CLI and the MCP server:
 *
 *   pre-request scripts (collection → folders → request)
 *   → variable resolution + auth → HTTP send
 *   → test scripts (collection → folders → request)
 *
 * See ARCHITECTURE.md §2.
 */
import type {
  BodyConfig,
  ConsoleEntry,
  CookieInfo,
  FolderDef,
  HttpResponse,
  KeyValue,
  RequestDef,
  TestResult,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { Resolver, redactSecrets, type VariableScopes } from "./variables/resolver";
import { prepareRequest, type RequestDefaults } from "./http/prepare";
import { sendRequest, type EngineOptions } from "./http/engine";
import type { CookieJarStore } from "./http/cookies";
import type { HostPolicy } from "./http/policy";
import type { OAuth2Token } from "./http/auth";
import {
  runScript,
  type SandboxHeader,
  type SandboxRequest,
  type SandboxResponse,
  type ScriptLimits,
  type SendRequestSpec,
} from "./scripts/sandbox";

/** Saved requests are resolved by callers; core never accesses persistence. */
export interface SavedRequest {
  request: RequestDef;
  ancestors: FolderDef[];
  collectionVariables?: Record<string, string>;
  secrets?: string[];
  onExecution?: (result: ExecuteResult) => void;
}

export type SavedRequestResolver = (requestId: string) => SavedRequest | Promise<SavedRequest>;

export interface ExecuteOptions {
  scriptModules?: ModuleSnapshot;
  request: RequestDef;
  resolveRequest?: SavedRequestResolver;
  /** Ancestor folders, collection first. */
  ancestors: FolderDef[];
  scopes: VariableScopes;
  cookieJar?: CookieJarStore;
  policy?: HostPolicy;
  /** Secret values to redact from logs and the reported request. */
  secrets?: string[];
  iteration?: number;
  iterationCount?: number;
  signal?: AbortSignal;
  scriptLimits?: Partial<ScriptLimits>;
  /** Instance-wide default headers, User-Agent and Accept behaviour (also used by pm.sendRequest). */
  requestDefaults?: RequestDefaults;
  oauth2CacheScope?: string;
  /** Run-level overrides (e.g. the runner's global timeout / SSL setting). */
  overrides?: { timeoutMs?: number; verifySsl?: boolean };
}

export interface SentRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** UTF-8 preview of the body (truncated, secrets redacted). */
  body?: string;
  bodySize: number;
}

export interface ScriptError {
  phase: "prerequest" | "test";
  source: string;
  message: string;
}

export interface ExecuteResult {
  visualization?: Visualization | null;
  visualizationResult?: VisualizerResult;
  response?: HttpResponse;
  /** Network / preparation error (no response received). */
  error?: string;
  errorCode?: string;
  tests: TestResult[];
  logs: ConsoleEntry[];
  scriptErrors: ScriptError[];
  /** Scopes after all scripts ran (caller persists the diff). */
  scopes: VariableScopes;
  unresolved: string[];
  sent?: SentRequest;
  skipped: boolean;
  nextRequest?: string | null;
  nextRequestSet: boolean;
  oauth2Token?: OAuth2Token;
}

const BODY_PREVIEW_LIMIT = 64 * 1024;

// ------------------------------------------------------------------ request <-> sandbox mapping

function toSandboxHeaders(list: KeyValue[]): SandboxHeader[] {
  return list.filter((h) => h.key).map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled }));
}

/** Strip inline file payloads before handing the body to the sandbox. */
function bodyForSandbox(body: BodyConfig): Record<string, unknown> {
  if (body.mode === "formdata") {
    return { ...body, formdata: body.formdata.map(({ data: _data, ...rest }) => rest) };
  }
  if (body.mode === "binary")
    return { mode: "binary", binary: body.binary ? { fileName: body.binary.fileName } : null };
  return { ...body };
}

function bodyFromSandbox(original: BodyConfig, next: Record<string, unknown> | null | undefined): BodyConfig {
  if (!next || typeof next.mode !== "string") return original;
  switch (next.mode) {
    case "none":
      return { mode: "none" };
    case "raw":
      return {
        mode: "raw",
        raw: String(next.raw ?? ""),
        language: (next.language as "json") ?? (original.mode === "raw" ? original.language : "text"),
      };
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: normalizeKv(next.urlencoded) };
    case "graphql": {
      const g = (next.graphql ?? {}) as Record<string, unknown>;
      return {
        mode: "graphql",
        graphql: {
          query: String(g.query ?? ""),
          variables: typeof g.variables === "string" ? g.variables : JSON.stringify(g.variables ?? {}),
          operationName: g.operationName as string | undefined,
        },
      };
    }
    case "formdata": {
      if (original.mode !== "formdata") return original;
      const files = new Map(original.formdata.filter((f) => f.type === "file").map((f) => [f.key, f]));
      const fields = Array.isArray(next.formdata) ? (next.formdata as Record<string, unknown>[]) : [];
      return {
        mode: "formdata",
        formdata: fields.map((f) => {
          const key = String(f.key ?? "");
          const file = files.get(key);
          if (f.type === "file" && file)
            return { ...file, enabled: f.disabled ? false : ((f.enabled as boolean) ?? true) };
          return {
            key,
            value: String(f.value ?? ""),
            enabled: !(f.disabled ?? false) && f.enabled !== false,
            type: "text" as const,
          };
        }),
      };
    }
    default:
      return original;
  }
}

function normalizeKv(list: unknown): KeyValue[] {
  if (!Array.isArray(list)) return [];
  return list.map((x: Record<string, unknown>) => ({
    key: String(x.key ?? ""),
    value: String(x.value ?? ""),
    enabled: !(x.disabled ?? false) && x.enabled !== false,
  }));
}

function toSandboxRequest(r: RequestDef): SandboxRequest {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    method: r.method,
    headers: toSandboxHeaders(r.headers),
    body: bodyForSandbox(r.body),
    auth: r.auth,
  };
}

function applySandboxRequest(r: RequestDef, s: SandboxRequest): RequestDef {
  return {
    ...r,
    url: s.url,
    method: s.method || r.method,
    headers: (s.headers ?? []).map((h) => ({
      key: h.key,
      value: String(h.value ?? ""),
      enabled: !h.disabled,
    })),
    body: bodyFromSandbox(r.body, s.body ?? null),
    auth: (s.auth as RequestDef["auth"] | undefined) ?? r.auth,
  };
}

export function toSandboxResponse(res: HttpResponse): SandboxResponse {
  return {
    code: res.status,
    status: res.statusText,
    headers: res.headers.map(([key, value]) => ({ key, value })),
    body: res.bodyText,
    bodyBase64: res.isBinary ? res.bodyBase64 : undefined,
    responseTime: Math.round(res.timings.total),
    responseSize: res.size,
    cookies: res.cookies,
  };
}

// ------------------------------------------------------------------ pipeline

export async function execute(opts: ExecuteOptions): Promise<ExecuteResult> {
  return executeInternal(opts, {
    depth: 0,
    budget: { remaining: 100 },
    collections: new Map([[opts.ancestors[0]?.id ?? null, { ...opts.scopes.collection }]]),
  });
}

function applyChanges(
  target: Record<string, string>,
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, string> {
  const out = { ...target };
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) delete out[key];
  for (const [key, value] of Object.entries(after))
    if (!Object.hasOwn(before, key) || before[key] !== value)
      Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  return out;
}

async function executeInternal(
  opts: ExecuteOptions,
  context: {
    depth: number;
    budget: { remaining: number };
    collections: Map<string | null, Record<string, string>>;
    variables?: Record<string, string>;
  },
): Promise<ExecuteResult> {
  const secrets = opts.secrets ?? [];
  const logs: ConsoleEntry[] = [];
  const tests: TestResult[] = [];
  const scriptErrors: ScriptError[] = [];
  let visualization: Visualization | null | undefined;
  let visualizationResult: VisualizerResult | undefined;
  let scopes: VariableScopes = structuredClone(opts.scopes);
  let request: RequestDef = structuredClone(opts.request);
  const effectiveScopes = () => ({ ...scopes, local: { ...scopes.local, ...context.variables } });
  const collectionId = opts.ancestors[0]?.id ?? null;
  const initialCollection = { ...scopes.collection };
  const syncCollection = (current: VariableScopes) => {
    context.collections.set(
      collectionId,
      applyChanges(context.collections.get(collectionId) ?? {}, initialCollection, current.collection),
    );
  };
  let nextRequest: string | null | undefined;
  let nextRequestSet = false;

  const jar = request.settings?.useCookieJar === false ? undefined : opts.cookieJar;
  const engine: EngineOptions = {
    cookieJar: jar,
    policy: opts.policy,
    signal: opts.signal,
    oauth2CacheScope: opts.oauth2CacheScope,
  };
  const info = (eventName: "prerequest" | "test") => ({
    eventName,
    iteration: opts.iteration ?? 0,
    iterationCount: opts.iterationCount ?? 1,
    requestName: request.name,
    requestId: request.id,
    location: [...opts.ancestors.map((folder) => folder.name), request.name],
  });

  // pm.sendRequest implementation: resolve variables, send through the same engine/policy.
  const host = {
    runRequest: opts.resolveRequest
      ? async (
          requestId: string,
          options: { variables?: Record<string, unknown> },
          signal?: AbortSignal,
          currentScopes?: VariableScopes,
        ) => {
          if (context.depth >= 5)
            throw new Error("pm.execution.runRequest exceeded the recursion limit of 5");
          if (--context.budget.remaining < 0)
            throw new Error("pm.execution.runRequest exceeded the execution budget of 100");
          const combinedSignal =
            signal && opts.signal ? AbortSignal.any([signal, opts.signal]) : (signal ?? opts.signal);
          combinedSignal?.throwIfAborted();
          const saved = await opts.resolveRequest!(requestId);
          combinedSignal?.throwIfAborted();
          for (const secret of saved.secrets ?? []) if (!secrets.includes(secret)) secrets.push(secret);
          const before = structuredClone(currentScopes ?? scopes);
          syncCollection(before);
          const sourceBefore = { ...context.collections.get(collectionId) };
          const targetId = saved.ancestors[0]?.id ?? null;
          const sameCollection = targetId === collectionId;
          if (!context.collections.has(targetId))
            context.collections.set(targetId, { ...saved.collectionVariables });
          const childScopes = structuredClone(before);
          if (!sameCollection) childScopes.collection = { ...context.collections.get(targetId) };
          const overrides = Object.fromEntries(
            Object.entries(options.variables ?? {}).map(([key, value]) => [
              key,
              value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value),
            ]),
          );
          childScopes.local = { ...childScopes.local, ...overrides };
          const child = await executeInternal(
            {
              ...opts,
              request: saved.request,
              ancestors: saved.ancestors,
              scopes: childScopes,
              secrets,
              signal: combinedSignal,
            },
            { ...context, depth: context.depth + 1, variables: overrides },
          );
          combinedSignal?.throwIfAborted();
          tests.push(...child.tests);
          logs.push(...child.logs);
          scriptErrors.push(...child.scriptErrors);
          const returnedScopes = structuredClone(child.scopes);
          // Overrides are invocation-local and must not escape back into the caller.
          for (const key of Object.keys(overrides)) {
            if (Object.hasOwn(before.local, key)) returnedScopes.local[key] = before.local[key];
            else delete returnedScopes.local[key];
          }
          saved.onExecution?.({
            ...child,
            scopes: { ...child.scopes, collection: context.collections.get(targetId)! },
          });
          returnedScopes.collection = applyChanges(
            before.collection,
            sourceBefore,
            context.collections.get(collectionId)!,
          );
          return {
            response: child.response ? toSandboxResponse(child.response) : null,
            scopes: returnedScopes,
            error: child.error,
          };
        }
      : undefined,
    sendRequest: async (
      spec: SendRequestSpec,
      signal?: AbortSignal,
      currentScopes?: VariableScopes,
    ): Promise<SandboxResponse> => {
      const hostEngine = {
        ...engine,
        signal:
          signal && engine.signal ? AbortSignal.any([signal, engine.signal]) : (signal ?? engine.signal),
      };
      const def: RequestDef = {
        id: "sendRequest",
        name: "pm.sendRequest",
        method: spec.method || "GET",
        url: spec.url,
        params: [],
        headers: (spec.header ?? []).map((h) => ({
          key: h.key,
          value: String(h.value),
          enabled: !h.disabled,
        })),
        body: bodyFromSandbox({ mode: "none" }, spec.body as Record<string, unknown> | null),
        auth: spec.auth ?? { type: "none" },
        preRequestScript: "",
        testScript: "",
        settings: { ...DEFAULT_SETTINGS },
      };
      if (spec.body?.mode === "formdata") {
        def.body = {
          mode: "formdata",
          formdata: normalizeKv(spec.body.formdata).map((f) => ({ ...f, type: "text" as const })),
        };
      }
      const { prepared } = await prepareRequest(def, [], new Resolver(currentScopes ?? scopes), hostEngine, {
        defaults: opts.requestDefaults,
      });
      const res = await sendRequest(prepared, hostEngine);
      logs.push({
        level: "info",
        source: "network",
        message: redactSecrets(
          `pm.sendRequest ${prepared.method} ${prepared.url} → ${res.status} (${Math.round(res.timings.total)} ms)`,
          secrets,
        ),
        timestamp: Date.now(),
      });
      return toSandboxResponse(res);
    },
  };

  const chain: { label: string; name: string; pre: string; test: string }[] = [
    ...opts.ancestors.map((f, i) => ({
      name: f.name,
      label: `${i === 0 ? "Collection" : "Folder"} "${f.name}"`,
      pre: f.preRequestScript,
      test: f.testScript,
    })),
    {
      label: `Request "${request.name}"`,
      name: request.name,
      pre: request.preRequestScript,
      test: request.testScript,
    },
  ];

  const runPhase = async (
    phase: "prerequest" | "test",
    response?: SandboxResponse,
    cookies?: CookieInfo[],
  ) => {
    for (const step of chain) {
      const code = phase === "prerequest" ? step.pre : step.test;
      if (!code?.trim()) continue;
      const source = `${step.label} ${phase === "prerequest" ? "pre-request" : "post-response"}`;
      const result = await runScript(
        code,
        {
          scopes,
          visualization,
          scriptModules: opts.scriptModules,
          request: toSandboxRequest(request),
          response,
          info: { ...info(phase), locationCurrent: step.name },
          cookies,
          variableOverrides: context.variables,
        },
        { host, limits: opts.scriptLimits, secrets, source, signal: opts.signal },
      );
      scopes = result.scopes;
      if (result.visualizationSet) {
        visualization = result.visualization;
        visualizationResult = visualization
          ? await renderVisualization(visualization, secrets, opts.signal)
          : undefined;
      }
      logs.push(...result.logs);
      tests.push(...result.tests);
      if (phase === "prerequest") request = applySandboxRequest(request, result.request);
      if (result.error) scriptErrors.push({ phase, source, message: result.error });
      if (result.nextRequestSet) {
        nextRequest = result.nextRequest;
        nextRequestSet = true;
      }
      if (result.skipRequest) return true;
    }
    return false;
  };

  const base = (): ExecuteResult => {
    syncCollection(scopes);
    return {
      ...(visualization !== undefined
        ? {
            visualization: redactStoredValue(
              redactSensitiveFields(visualization),
              credentialRedactionValues(secrets),
            ),
            visualizationResult,
          }
        : {}),
      tests: tests.map((test) => ({
        ...test,
        error: test.error ? redactSecrets(test.error, secrets) : test.error,
      })),
      logs: logs.map((entry) => ({ ...entry, message: redactSecrets(entry.message, secrets) })),
      scriptErrors: scriptErrors.map((error) => ({
        ...error,
        message: redactSecrets(error.message, secrets),
      })),
      scopes,
      unresolved: [],
      skipped: false,
      nextRequest,
      nextRequestSet,
    };
  };

  // 1. pre-request scripts
  const jarCookies = jar ? await jar.forUrl(new Resolver(effectiveScopes()).resolve(request.url)) : [];
  const skipped = await runPhase("prerequest", undefined, jarCookies);
  if (skipped) return { ...base(), skipped: true };

  // 2. resolve + prepare
  if (opts.overrides?.timeoutMs)
    request.settings = { ...request.settings, timeoutMs: opts.overrides.timeoutMs };
  if (opts.overrides?.verifySsl === false) request.settings = { ...request.settings, verifySsl: false };
  const resolver = new Resolver(effectiveScopes());
  let prepared;
  let oauth2Token: OAuth2Token | undefined;
  try {
    const p = await prepareRequest(request, opts.ancestors, resolver, engine, {
      defaults: opts.requestDefaults,
    });
    prepared = p.prepared;
    oauth2Token = p.oauth2Token;
  } catch (err) {
    return {
      ...base(),
      unresolved: [...resolver.unresolved],
      error: redactSecrets((err as Error).message, secrets),
    };
  }
  const unresolved = [...resolver.unresolved];

  const sent: SentRequest = {
    method: prepared.method,
    url: redactSecrets(prepared.url, secrets),
    headers: prepared.headers.map(([k, v]) => [k, redactSecrets(v, secrets)]),
    body: prepared.body
      ? redactSecrets(prepared.body.subarray(0, BODY_PREVIEW_LIMIT).toString("utf8"), secrets)
      : undefined,
    bodySize: prepared.body?.length ?? 0,
  };

  // 3. send
  let response: HttpResponse;
  try {
    response = await sendRequest(prepared, engine);
  } catch (err) {
    const e = err as Error & { code?: string };
    const message = redactSecrets(e.message, secrets);
    logs.push({
      level: "error",
      source: "network",
      message: `${sent.method} ${sent.url} → ${message}`,
      timestamp: Date.now(),
    });
    return { ...base(), unresolved, sent, error: message, errorCode: e.code, oauth2Token };
  }
  logs.push({
    level: "info",
    source: "network",
    message: `${sent.method} ${sent.url} → ${response.status} ${response.statusText} (${Math.round(response.timings.total)} ms, ${response.size} B)`,
    timestamp: Date.now(),
  });

  // 4. test scripts
  const cookiesAfter = jar ? await jar.forUrl(response.url) : [];
  await runPhase("test", toSandboxResponse(response), cookiesAfter);

  return { ...base(), response, unresolved, sent, oauth2Token };
}

/** True when the execution produced no failures (used by the runner). */
export function executionPassed(r: ExecuteResult): boolean {
  return !r.error && r.scriptErrors.length === 0 && r.tests.every((t) => t.passed);
}
