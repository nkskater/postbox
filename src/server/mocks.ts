/** Workspace-managed snapshots of saved examples. Serving a mock never executes scripts or makes outbound calls. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { mockCreateSchema, mockPatchSchema, type MockRoute } from "@/core/mocks/model";
import { matchMock } from "@/core/mocks/matcher";
import {
  MAX_SIMULATED_DELAY_MS,
  ScenarioState,
  SESSION_HEADER,
  evaluateScenarios,
  parseSession,
} from "@/core/mocks/scenarios";
import {
  HandlerState,
  handlerApplies,
  handlerHeaders,
  runHandler,
  type HandlerInput,
  type HandlerResult,
  type HandlerRun,
  type StateValues,
} from "@/core/mocks/handlers";
import { requestFromExample, sanitizeExample } from "@/core/examples";
import { credentialRedactionValues, redactSensitiveFields } from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";
import type { BodyConfig, KeyValue, TreeNode } from "@/core/types";
import { getDb, schema } from "./db";
import * as repo from "./repo";
import { workspaceRole } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError, notFound } from "./errors";
import { newId } from "./defaults";
import { readBodyText } from "./http";
const { mockServers, mockLogs, variables } = schema;
/** Scenario counters live in memory (they are test-session state, not data) and survive hot reloads. */
const scenarioState = ((
  globalThis as unknown as { __postboxScenarioState?: ScenarioState }
).__postboxScenarioState ??= new ScenarioState());
/** Handler state is likewise test-session data held in memory. */
const handlerState = ((
  globalThis as unknown as { __postboxHandlerState?: HandlerState }
).__postboxHandlerState ??= new HandlerState());
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const row = (id: string) => {
  const result = getDb().select().from(mockServers).where(eq(mockServers.id, id)).get();
  if (!result) throw notFound("Mock server");
  return result;
};
const secrets = (workspaceId: string) =>
  credentialRedactionValues(
    getDb()
      .select({ value: variables.value })
      .from(variables)
      .where(and(eq(variables.workspaceId, workspaceId), eq(variables.type, "secret")))
      .all()
      .map((v) => v.value),
  );
function safeHeaders(headers: KeyValue[], workspaceId: string) {
  const safe = redactStoredValue(redactSensitiveFields(headers), secrets(workspaceId));
  for (const header of safe)
    if (
      header.enabled &&
      (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.key) || /[\r\n\0]/.test(header.value))
    )
      throw new HttpError(400, "Invalid mock response header");
  return safe;
}
function requestBody(body: BodyConfig): string {
  if (body.mode === "none") return "";
  if (body.mode === "raw") return body.raw;
  if (body.mode === "urlencoded")
    return new URLSearchParams(
      body.urlencoded.filter((p) => p.enabled).map((p) => [p.key, p.value]),
    ).toString();
  throw new Error("Multipart, binary and GraphQL request matching require a raw or empty saved request body");
}
function snapshot(workspaceId: string, folderId: string): MockRoute[] {
  repo.requireFolderIn(workspaceId, folderId);
  const tree = repo.getFolderTree(folderId);
  if (!tree) throw notFound("Collection");
  const routes: MockRoute[] = [];
  const problems: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === "folder") {
      node.children.forEach(walk);
      return;
    }
    for (const example of node.examples ?? []) {
      try {
        const response = sanitizeExample(example, secrets(workspaceId));
        if (response.status < 200)
          throw new Error("Informational response statuses cannot be served as a final mock response");
        if (response.bodyOmitted || response.truncated)
          throw new Error("Response bytes are omitted or truncated");
        const request = requestFromExample(response, node);
        if (request.method === "GRPC" || request.method === "WS")
          throw new Error("Only HTTP request examples are supported");
        const raw = request.url.replace(/^\{\{[^{}]+\}\}/, "https://mock.invalid");
        const url = new URL(raw, "https://mock.invalid");
        if (request.params.length) {
          url.search = "";
          for (const param of request.params)
            if (param.enabled) url.searchParams.append(param.key, param.value);
        }
        decodeURIComponent(url.pathname);
        routes.push({
          id: response.id,
          requestId: node.id,
          name: response.name,
          method: request.method,
          path: url.pathname,
          query: [...url.searchParams],
          body: requestBody(request.body),
          status: response.status,
          response: {
            ...response,
            originalRequest: undefined,
            headers: safeHeaders(response.headers, workspaceId),
          },
        });
      } catch (error) {
        problems.push(`${node.name}: ${(error as Error).message}`);
      }
    }
  };
  walk(tree);
  if (problems.length) throw new HttpError(400, problems.slice(0, 5).join("; "));
  if (!routes.length)
    throw new HttpError(400, "Add at least one complete saved response example to this collection first");
  if (routes.length > 1000 || Buffer.byteLength(JSON.stringify(routes)) > 20 * 1024 * 1024)
    throw new HttpError(400, "Mock snapshot exceeds 1,000 examples or 20 MiB");
  return routes;
}
function document(record: ReturnType<typeof row>, includeRoutes = true) {
  const { keyHash: _keyHash, routes, ...fields } = record;
  const safe = redactStoredValue(fields, secrets(record.workspaceId));
  return {
    ...safe,
    id: record.id,
    workspaceId: record.workspaceId,
    folderId: record.folderId,
    routeCount: routes.length,
    canEdit: workspaceRole(currentCaller(), record.workspaceId) !== "viewer",
    ...(includeRoutes
      ? {
          routes: routes.map((route) => ({
            ...redactStoredValue(route, secrets(record.workspaceId)),
            id: route.id,
            requestId: route.requestId,
            response: sanitizeExample(route.response, secrets(record.workspaceId)),
          })),
        }
      : {}),
  };
}
export function listMocks(workspaceId: string) {
  repo.requireWorkspace(workspaceId);
  return getDb()
    .select()
    .from(mockServers)
    .where(eq(mockServers.workspaceId, workspaceId))
    .orderBy(desc(mockServers.updatedAt))
    .all()
    .map((r) => document(r, false));
}
export function getMock(id: string) {
  return document(row(id));
}
export function createMock(raw: z.input<typeof mockCreateSchema>) {
  const input = mockCreateSchema.parse(raw);
  const routes = snapshot(input.workspaceId, input.folderId);
  const key = randomBytes(32).toString("base64url"),
    now = Date.now(),
    id = newId();
  getDb()
    .insert(mockServers)
    .values({
      ...input,
      headers: safeHeaders(input.headers, input.workspaceId),
      routes,
      id,
      keyHash: hash(key),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { ...getMock(id), key };
}
export function updateMock(id: string, raw: z.input<typeof mockPatchSchema>) {
  const previous = row(id),
    patch = mockPatchSchema.parse(raw);
  getDb()
    .update(mockServers)
    .set({
      ...patch,
      ...(patch.headers ? { headers: safeHeaders(patch.headers, previous.workspaceId) } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(mockServers.id, id))
    .run();
  // Counters belong to the scenarios as defined; a changed set starts every session over.
  if (patch.scenarios) scenarioState.reset(id);
  if (patch.handlers) handlerState.reset(id);
  return getMock(id);
}
export function refreshMock(id: string) {
  const previous = row(id),
    routes = snapshot(previous.workspaceId, previous.folderId);
  getDb()
    .update(mockServers)
    .set({ routes, revision: previous.revision + 1, updatedAt: Date.now() })
    .where(eq(mockServers.id, id))
    .run();
  return getMock(id);
}
export function rotateMockKey(id: string) {
  row(id);
  const key = randomBytes(32).toString("base64url");
  getDb()
    .update(mockServers)
    .set({ keyHash: hash(key), updatedAt: Date.now() })
    .where(eq(mockServers.id, id))
    .run();
  return { key };
}
export function deleteMock(id: string) {
  row(id);
  getDb().delete(mockServers).where(eq(mockServers.id, id)).run();
  scenarioState.reset(id);
  handlerState.reset(id);
  return { ok: true };
}
/** Restart the failure simulations of one session (or every session) so a test run starts clean. */
export function resetMockState(id: string, session?: string) {
  row(id);
  if (session !== undefined && parseSession(session) === null)
    throw new HttpError(400, "Invalid session name");
  return { ok: true, cleared: Math.max(scenarioState.reset(id, session), handlerState.reset(id, session)) };
}

/** Per-session handler state and call counts, for debugging. */
export function inspectMockState(id: string) {
  row(id);
  return { sessions: handlerState.inspect(id) };
}

export interface HandlerTestInput {
  /** Handler to run: a saved one by id, or unsaved code. */
  handlerId?: string;
  code?: string;
  request?: {
    method?: string;
    path?: string;
    query?: [string, string][];
    headers?: Record<string, string>;
    body?: string;
  };
  state?: StateValues;
  count?: number;
  session?: string;
  /** Use the mock's saved example with this id (or the first one matching the path) as `example`. */
  exampleId?: string;
}

/** Run a handler against a made-up request without touching saved session state. */
export async function testMockHandler(
  id: string,
  input: HandlerTestInput,
): Promise<HandlerRun & { state: StateValues }> {
  const record = row(id);
  const saved = input.handlerId ? (record.handlers ?? []).find((h) => h.id === input.handlerId) : undefined;
  if (input.handlerId && !saved) throw notFound("Handler");
  const code = input.code ?? saved?.code;
  if (code === undefined) throw new HttpError(400, "Provide code or a handlerId");
  const session = input.session ?? "test";
  if (parseSession(session) === null) throw new HttpError(400, "Invalid session name");
  const method = (input.request?.method ?? "GET").toUpperCase();
  const path = input.request?.path ?? "/";
  if (!/^[A-Z]{1,16}$/.test(method) || !path.startsWith("/"))
    throw new HttpError(400, "Invalid test request");
  const bodyText = input.request?.body ?? "";
  const route = input.exampleId
    ? record.routes.find((r) => r.id === input.exampleId)
    : matchMock(
        record.routes,
        { method, path, query: input.request?.query ?? [], body: bodyText },
        { matchQuery: false, matchBody: false },
      );
  if (input.exampleId && !route) throw notFound("Example");
  const handlerInput: HandlerInput = {
    request: {
      method,
      path,
      query: input.request?.query ?? [],
      headers: input.request?.headers ?? {},
      body: bodyText,
    },
    example: route ? exampleOf(sanitizeExample(route.response, secrets(record.workspaceId)), route.id) : null,
    state: input.state ?? {},
    count: input.count ?? 1,
    session,
    mockId: id,
    handlerId: saved?.id ?? input.handlerId ?? "test",
  };
  const run = await runHandler(code, handlerInput);
  return { ...run, state: run.ok ? run.state : handlerInput.state };
}

function exampleOf(
  response: { name: string; status: number; headers: KeyValue[]; body: string; bodyEncoding?: string },
  id: string,
) {
  return {
    id,
    name: response.name,
    status: response.status,
    headers: Object.fromEntries(
      response.headers.filter((h) => h.enabled).map((h) => [h.key.toLowerCase(), h.value]),
    ),
    body: response.bodyEncoding === "base64" ? null : response.body,
  };
}
export function listMockLogs(id: string) {
  row(id);
  return getDb()
    .select()
    .from(mockLogs)
    .where(eq(mockLogs.mockId, id))
    .orderBy(desc(mockLogs.createdAt))
    .limit(100)
    .all();
}
export function clearMockLogs(id: string) {
  row(id);
  getDb().delete(mockLogs).where(eq(mockLogs.mockId, id)).run();
  return { ok: true };
}
export function exportMock(id: string) {
  const { canEdit: _canEdit, ...data } = getMock(id);
  return { format: "postbox.mock", formatVersion: 1, ...data };
}
const blockedHeaders = new Set([
  "set-cookie",
  "set-cookie2",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "clear-site-data",
  "refresh",
  "service-worker-allowed",
]);
export async function serveMock(request: Request, id: string) {
  const started = Date.now();
  const secure = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const error = (status: number, message: string) =>
    Response.json({ error: message }, { status, headers: secure });
  let record: ReturnType<typeof row>;
  try {
    record = row(id);
  } catch {
    return error(404, "Mock server not found");
  }
  if (!record.enabled) return error(404, "Mock server not found");
  if (!record.public) {
    const key = request.headers.get("x-postbox-mock-key") ?? "";
    if (
      key.length > 256 ||
      !timingSafeEqual(Buffer.from(hash(key), "hex"), Buffer.from(record.keyHash, "hex"))
    )
      return error(401, "Mock key required");
  }
  try {
    const url = new URL(request.url),
      prefix = `/mock/${id}`,
      path = url.pathname.slice(prefix.length) || "/";
    const session = parseSession(request.headers.get(SESSION_HEADER));
    if (session === null) return error(400, "Invalid x-mock-session header");
    const body = await readBodyText(request, 1024 * 1024);
    const statusHeader = request.headers.get("x-mock-response-code");
    if (statusHeader && !/^\d{3}$/.test(statusHeader)) return error(400, "Invalid example response status");
    const candidates = record.routes.map((route) => ({
      ...route,
      response: sanitizeExample(route.response, secrets(record.workspaceId)),
    }));
    const selected = matchMock(
      candidates,
      { method: request.method, path, query: [...url.searchParams], body },
      {
        matchQuery: record.matchQuery,
        matchBody: record.matchBody,
        exampleId: request.headers.get("x-mock-response-id") ?? undefined,
        exampleName: request.headers.get("x-mock-response-name") ?? undefined,
        status: statusHeader ? Number(statusHeader) : undefined,
      },
    );
    if (request.signal.aborted) return error(499, "Mock request cancelled");
    const outcome = evaluateScenarios(
      record.scenarios ?? [],
      { method: request.method, path },
      scenarioState,
      { mockId: id, session },
      Date.now(),
    );
    const delayMs = Math.min(MAX_SIMULATED_DELAY_MS, record.delayMs + outcome.delayMs);
    const failure = outcome.failure;
    if (delayMs)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new HttpError(499, "Mock request cancelled"));
        };
        const timer = setTimeout(() => {
          request.signal.removeEventListener("abort", abort);
          resolve();
        }, delayMs);
        request.signal.addEventListener("abort", abort, { once: true });
      });
    // A handler runs for requests that no failure simulation has already answered.
    let handled: { result: HandlerResult | null; id: string; name: string } | null = null;
    let handlerFailure: { id: string; name: string; message: string } | null = null;
    const handler = failure
      ? undefined
      : (record.handlers ?? []).find((h) => handlerApplies(h, { method: request.method, path }));
    if (handler) {
      const example = selected ? exampleOf(selected.response, selected.id) : null;
      const run = await handlerState.serialize(id, session, async () => {
        const turn = handlerState.begin(id, session, handler.id, Date.now());
        const outcomeRun = await runHandler(handler.code, {
          request: {
            method: request.method,
            path,
            query: [...url.searchParams],
            headers: handlerHeaders(request.headers),
            body,
          },
          example,
          state: turn.state,
          count: turn.count,
          session,
          mockId: id,
          handlerId: handler.id,
        });
        if (outcomeRun.ok)
          handlerState.commit(id, session, handler.id, turn.count, outcomeRun.state, Date.now());
        else handlerState.countOnly(id, session, handler.id, turn.count, Date.now());
        return outcomeRun;
      });
      if (run.ok) handled = { result: run.result, id: handler.id, name: handler.name };
      else handlerFailure = { id: handler.id, name: handler.name, message: run.error };
    }
    const custom = handled?.result ?? null;
    const status = failure
      ? failure.status
      : handlerFailure
        ? 500
        : custom
          ? (custom.status ?? record.status ?? selected?.status ?? 200)
          : selected
            ? (record.status ?? selected.status)
            : 404;
    getDb().transaction((tx) => {
      tx.insert(mockLogs)
        .values({
          id: newId(),
          mockId: id,
          method: request.method,
          path: selected ? redactStoredValue(selected.path, secrets(record.workspaceId)) : "[unmatched]",
          status,
          exampleId:
            failure || handlerFailure || custom?.body !== undefined || custom?.json !== undefined
              ? null
              : (selected?.id ?? null),
          durationMs: Date.now() - started,
          createdAt: Date.now(),
        })
        .run();
      const excess = tx
        .select({ id: mockLogs.id })
        .from(mockLogs)
        .where(eq(mockLogs.mockId, id))
        .orderBy(desc(mockLogs.createdAt))
        .all()
        .slice(100);
      if (excess.length)
        tx.delete(mockLogs)
          .where(
            inArray(
              mockLogs.id,
              excess.map((v) => v.id),
            ),
          )
          .run();
    });
    if (failure) {
      const simulated = new Headers();
      for (const [name, value] of failure.headers) simulated.set(name, value);
      for (const [name, value] of Object.entries(secure)) simulated.set(name, value);
      simulated.set("Content-Type", failure.contentType);
      simulated.set("X-Postbox-Mock-Scenario", failure.scenarioId);
      simulated.set("X-Postbox-Mock-Session", session);
      return new Response(
        request.method === "HEAD" ? null : redactStoredValue(failure.body, secrets(record.workspaceId)),
        { status, headers: simulated },
      );
    }
    if (handlerFailure) {
      const failed = new Headers();
      for (const [name, value] of Object.entries(secure)) failed.set(name, value);
      failed.set("Content-Type", "application/json");
      failed.set("X-Postbox-Mock-Handler", handlerFailure.id);
      failed.set("X-Postbox-Mock-Session", session);
      return new Response(
        request.method === "HEAD"
          ? null
          : redactStoredValue(
              JSON.stringify({
                error: "Mock handler failed",
                handler: handlerFailure.name,
                detail: handlerFailure.message.slice(0, 500),
              }),
              secrets(record.workspaceId),
            ),
        { status, headers: failed },
      );
    }
    if (!selected && !custom) return error(404, "No saved example matched the request");
    const ownBody = custom !== null && (custom.body !== undefined || custom.json !== undefined);
    const headers = new Headers();
    const rows: KeyValue[] = [
      ...(selected && !ownBody ? selected.response.headers : []),
      ...safeHeaders(record.headers, record.workspaceId),
      ...Object.entries(custom?.headers ?? {}).map(([key, value]) => ({ key, value, enabled: true })),
    ];
    for (const header of rows)
      if (header.enabled && !blockedHeaders.has(header.key.toLowerCase()))
        headers.set(header.key, header.value);
    for (const [name, value] of outcome.headers) headers.set(name, value);
    for (const [name, value] of Object.entries(secure)) headers.set(name, value);
    if (selected && !ownBody) headers.set("X-Postbox-Mock-Example", selected.id);
    if (handled) headers.set("X-Postbox-Mock-Handler", handled.id);
    headers.set("X-Postbox-Mock-Session", session);
    if (custom?.contentType) headers.set("Content-Type", custom.contentType);
    else if (custom?.json !== undefined && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "text/plain; charset=utf-8");
    const responseBody = ownBody
      ? redactStoredValue(
          custom!.json !== undefined ? JSON.stringify(custom!.json) : String(custom!.body),
          secrets(record.workspaceId),
        )
      : selected
        ? selected.response.bodyEncoding === "base64"
          ? Buffer.from(selected.response.body, "base64")
          : selected.response.body
        : "";
    return new Response(request.method === "HEAD" || [204, 205, 304].includes(status) ? null : responseBody, {
      status,
      headers,
    });
  } catch (errorValue) {
    return error(
      errorValue instanceof HttpError ? errorValue.status : 400,
      errorValue instanceof HttpError ? errorValue.message : "Invalid mock request or saved example",
    );
  }
}
