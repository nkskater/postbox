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
  return { ok: true };
}
/** Restart the failure simulations of one session (or every session) so a test run starts clean. */
export function resetMockState(id: string, session?: string) {
  row(id);
  if (session !== undefined && parseSession(session) === null)
    throw new HttpError(400, "Invalid session name");
  return { ok: true, cleared: scenarioState.reset(id, session) };
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
    const status = failure ? failure.status : selected ? (record.status ?? selected.status) : 404;
    getDb().transaction((tx) => {
      tx.insert(mockLogs)
        .values({
          id: newId(),
          mockId: id,
          method: request.method,
          path: selected ? redactStoredValue(selected.path, secrets(record.workspaceId)) : "[unmatched]",
          status,
          exampleId: failure ? null : (selected?.id ?? null),
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
    if (!selected) return error(404, "No saved example matched the request");
    const headers = new Headers();
    for (const header of [...selected.response.headers, ...safeHeaders(record.headers, record.workspaceId)])
      if (header.enabled && !blockedHeaders.has(header.key.toLowerCase()))
        headers.set(header.key, header.value);
    for (const [name, value] of outcome.headers) headers.set(name, value);
    for (const [name, value] of Object.entries(secure)) headers.set(name, value);
    headers.set("X-Postbox-Mock-Example", selected.id);
    headers.set("X-Postbox-Mock-Session", session);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "text/plain; charset=utf-8");
    const responseBody =
      selected.response.bodyEncoding === "base64"
        ? Buffer.from(selected.response.body, "base64")
        : selected.response.body;
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
