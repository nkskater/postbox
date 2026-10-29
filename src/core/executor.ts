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
import { prepareRequest } from "./http/prepare";
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

export interface ExecuteOptions {
  request: RequestDef;
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
  const secrets = opts.secrets ?? [];
  const logs: ConsoleEntry[] = [];
  const tests: TestResult[] = [];
  const scriptErrors: ScriptError[] = [];
  let scopes: VariableScopes = structuredClone(opts.scopes);
  let request: RequestDef = structuredClone(opts.request);
  let nextRequest: string | null | undefined;
  let nextRequestSet = false;

  const engine: EngineOptions = { cookieJar: opts.cookieJar, policy: opts.policy, signal: opts.signal };
  const info = (eventName: "prerequest" | "test") => ({
    eventName,
    iteration: opts.iteration ?? 0,
    iterationCount: opts.iterationCount ?? 1,
    requestName: request.name,
    requestId: request.id,
  });

  // pm.sendRequest implementation: resolve variables, send through the same engine/policy.
  const host = {
    sendRequest: async (spec: SendRequestSpec): Promise<SandboxResponse> => {
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
        auth: { type: "none" },
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
      const { prepared } = await prepareRequest(def, [], new Resolver(scopes), engine);
      const res = await sendRequest(prepared, engine);
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

  const chain: { label: string; pre: string; test: string }[] = [
    ...opts.ancestors.map((f, i) => ({
      label: `${i === 0 ? "Collection" : "Folder"} "${f.name}"`,
      pre: f.preRequestScript,
      test: f.testScript,
    })),
    { label: `Request "${request.name}"`, pre: request.preRequestScript, test: request.testScript },
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
        { scopes, request: toSandboxRequest(request), response, info: info(phase), cookies },
        { host, limits: opts.scriptLimits, secrets, source },
      );
      scopes = result.scopes;
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

  const base = (): ExecuteResult => ({
    tests,
    logs,
    scriptErrors,
    scopes,
    unresolved: [],
    skipped: false,
    nextRequest,
    nextRequestSet,
  });

  // 1. pre-request scripts
  const jarCookies = opts.cookieJar ? await opts.cookieJar.list() : [];
  const skipped = await runPhase("prerequest", undefined, jarCookies);
  if (skipped) return { ...base(), skipped: true };

  // 2. resolve + prepare
  if (opts.overrides?.timeoutMs)
    request.settings = { ...request.settings, timeoutMs: opts.overrides.timeoutMs };
  if (opts.overrides?.verifySsl === false) request.settings = { ...request.settings, verifySsl: false };
  const resolver = new Resolver(scopes);
  let prepared;
  let oauth2Token: OAuth2Token | undefined;
  try {
    const p = await prepareRequest(request, opts.ancestors, resolver, engine);
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
  const cookiesAfter = opts.cookieJar ? await opts.cookieJar.list() : response.cookies;
  await runPhase("test", toSandboxResponse(response), cookiesAfter);

  return { ...base(), response, unresolved, sent, oauth2Token };
}

/** True when the execution produced no failures (used by the runner). */
export function executionPassed(r: ExecuteResult): boolean {
  return !r.error && r.scriptErrors.length === 0 && r.tests.every((t) => t.passed);
}
