import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  gatewayRouteInput,
  applyGatewayPolicy,
  upstreamPath,
  GatewayPolicyError,
} from "@/core/gateway/model";
import { GatewayTransportError, openGatewayStream, type GatewayCompletion } from "@/core/gateway/transport";
import { checkVaultDomains } from "@/core/vault/guard";
import { validateMcpMetadata } from "@/core/gateway/mcp";
import { mcpSettings } from "./integration-settings";
import { requestHost } from "./request-origin";
import { METHODS, parseBaseUrl } from "@/core/broker/target";
import { authorize, workspaceRole, listMembers } from "./authorize";
import { currentCaller, callerScope } from "./access-context";
import { scopeAllows } from "@/core/scopes";
import { audit, actorOf } from "./audit";
import * as broker from "./broker";
import * as vault from "./vault";
import { getDb, schema } from "./db";
import { getPolicy } from "./context";
import { newId } from "./defaults";
import { HttpError, isHttpError } from "./errors";
const { gatewayRoutes: routes, gatewayTraces: traces } = schema;
type RouteRow = typeof routes.$inferSelect;

export const createGatewayRouteInput = gatewayRouteInput.extend({ workspaceId: z.string().min(1) });
export const gatewayProviderInput = broker.apiInput.extend({
  workspaceId: z.string().min(1),
  credentialValue: z.string().min(1).max(16384).optional(),
});
const consumerId = () => {
  const c = currentCaller();
  return c?.kind === "user" ? c.user.id : (c?.kind ?? null);
};

export function getGatewayRoute(id: string, action: "read" | "manage" | "run" = "read"): RouteRow {
  const row = getDb().select().from(routes).where(eq(routes.id, id)).get();
  if (!row) throw new HttpError(404, "Gateway route not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
function routeView(row: RouteRow) {
  return { ...row, endpoint: `/api/gateway/${row.id}`, provider: broker.getApi(row.apiId) };
}
export function gatewaySnapshot(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  const all = getDb().select().from(routes).where(eq(routes.workspaceId, workspaceId)).all();
  const recent = getDb()
    .select()
    .from(traces)
    .where(eq(traces.workspaceId, workspaceId))
    .orderBy(desc(traces.startedAt))
    .limit(200)
    .all();
  const canManage =
    workspaceRole(currentCaller(), workspaceId) === "owner" &&
    scopeAllows(callerScope(currentCaller()), "manage");
  return {
    members: canManage ? listMembers(workspaceId) : [],
    providers: broker.listApis(workspaceId),
    grants: broker.listGrants(workspaceId),
    consumerId: consumerId(),
    canManage,
    routes: all.map(routeView),
    traces: recent,
    health: {
      enabled: process.env.GATEWAY_ENABLED === "true",
      authenticated: currentCaller()?.kind !== "open",
      ready:
        process.env.GATEWAY_ENABLED === "true" && currentCaller()?.kind !== "open"
          ? all.filter(
              (r) =>
                r.enabled && broker.getApi(r.apiId).enabled && broker.getApi(r.apiId).secretState === "ok",
            ).length
          : 0,
      recentCalls: recent.length,
      recentErrors: recent.filter((t) => t.outcome !== "success" || (t.status ?? 0) >= 400).length,
    },
  };
}
export function createGatewayProvider(raw: z.input<typeof gatewayProviderInput>) {
  const { workspaceId, credentialValue, ...input } = gatewayProviderInput.parse(raw);
  authorize(currentCaller(), workspaceId, "manage");
  let hostname: string;
  try {
    hostname = parseBaseUrl(input.baseUrl).hostname;
  } catch {
    throw new HttpError(400, "Provider base URL must be an HTTP(S) URL without credentials or query");
  }
  return getDb().transaction(() => {
    if (credentialValue !== undefined)
      vault.createSecret(workspaceId, {
        name: input.secretName,
        value: credentialValue,
        domains: [hostname],
      });
    const api = broker.createApi(workspaceId, input);
    audit({
      action: "gateway.provider.create",
      entityKind: "brokerApi",
      entityId: api.id,
      entityName: api.name,
      workspaceId,
      changes: credentialValue ? [{ field: "credential", redacted: true }] : [],
    });
    return api;
  });
}
export function createGatewayRoute(raw: z.input<typeof createGatewayRouteInput>) {
  const { workspaceId, ...input } = createGatewayRouteInput.parse(raw);
  authorize(currentCaller(), workspaceId, "manage");
  if (broker.getApi(input.apiId).workspaceId !== workspaceId) throw new HttpError(404, "Provider not found");
  upstreamPath(input.upstreamPrefix, "/");
  const count = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(routes)
    .where(eq(routes.workspaceId, workspaceId))
    .get()!.n;
  if (count >= 100) throw new HttpError(409, "A workspace can have at most 100 gateway routes");
  if (
    getDb()
      .select()
      .from(routes)
      .where(and(eq(routes.workspaceId, workspaceId), eq(routes.name, input.name)))
      .get()
  )
    throw new HttpError(409, "Gateway route name is already in use");
  const now = Date.now();
  const row = { id: newId(), workspaceId, ...input, createdAt: now, updatedAt: now };
  getDb().insert(routes).values(row).run();
  audit({
    action: "gateway.route.create",
    entityKind: "other",
    entityId: row.id,
    entityName: row.name,
    workspaceId,
    changes: [],
  });
  return routeView(getGatewayRoute(row.id));
}
export function updateGatewayRoute(id: string, raw: z.input<typeof gatewayRouteInput>) {
  const before = getGatewayRoute(id, "manage");
  const input = gatewayRouteInput.parse(raw);
  if (broker.getApi(input.apiId).workspaceId !== before.workspaceId)
    throw new HttpError(404, "Provider not found");
  upstreamPath(input.upstreamPrefix, "/");
  const duplicate = getDb()
    .select()
    .from(routes)
    .where(and(eq(routes.workspaceId, before.workspaceId), eq(routes.name, input.name)))
    .get();
  if (duplicate && duplicate.id !== id) throw new HttpError(409, "Gateway route name is already in use");
  getDb()
    .update(routes)
    .set({ ...input, updatedAt: Date.now() })
    .where(eq(routes.id, id))
    .run();
  audit({
    action: "gateway.route.update",
    entityKind: "other",
    entityId: id,
    entityName: input.name,
    workspaceId: before.workspaceId,
    changes: [{ field: "policy", redacted: true }],
  });
  return routeView(getGatewayRoute(id));
}
export function deleteGatewayRoute(id: string) {
  const row = getGatewayRoute(id, "manage");
  getDb().delete(routes).where(eq(routes.id, id)).run();
  audit({
    action: "gateway.route.delete",
    entityKind: "other",
    entityId: id,
    entityName: row.name,
    workspaceId: row.workspaceId,
    changes: [],
  });
  return { ok: true };
}
export const gatewayGrantInput = z
  .object({
    consumerId: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    expiresInSec: z.number().int().min(60).max(31536000).default(86400),
  })
  .strict();
export function grantGatewayProvider(apiId: string, raw: z.input<typeof gatewayGrantInput>) {
  const provider = broker.getApi(apiId);
  authorize(currentCaller(), provider.workspaceId, "manage");
  const input = gatewayGrantInput.parse(raw);
  const id = input.consumerId ?? consumerId();
  if (!id) throw new HttpError(400, "A consumer is required");
  return broker.grantAccess(apiId, { ...input, consumerId: id });
}

class QuotaError extends GatewayPolicyError {
  constructor(readonly retryAfter: number) {
    super("quota", "Gateway route request quota exceeded", 429);
  }
}
export function reserveGatewayQuota(id: string, now = Date.now()): void {
  getDb().transaction((tx) => {
    const row = tx.select().from(routes).where(eq(routes.id, id)).get();
    if (!row || !row.enabled) throw new GatewayPolicyError("disabled", "Gateway route is disabled");
    const minute = Math.floor(now / 60000) * 60000,
      day = Math.floor(now / 86400000) * 86400000;
    const minuteUsed = row.minuteWindow === minute ? row.minuteUsed : 0,
      dayUsed = row.dayWindow === day ? row.dayUsed : 0;
    if (minuteUsed >= row.policy.requestsPerMinute)
      throw new QuotaError(Math.max(1, Math.ceil((minute + 60000 - now) / 1000)));
    if (dayUsed >= row.policy.requestsPerDay)
      throw new QuotaError(Math.max(1, Math.ceil((day + 86400000 - now) / 1000)));
    tx.update(routes)
      .set({ minuteWindow: minute, minuteUsed: minuteUsed + 1, dayWindow: day, dayUsed: dayUsed + 1 })
      .where(eq(routes.id, id))
      .run();
  });
}

function recordTrace(
  row: RouteRow,
  method: string,
  requestBytes: number,
  startedAt: number,
  actor: ReturnType<typeof actorOf>,
  result: GatewayCompletion,
) {
  const id = newId();
  getDb().transaction((tx) => {
    // The route can be deleted while an upstream stream is open.
    const exists = tx.select({ id: routes.id }).from(routes).where(eq(routes.id, row.id)).get();
    tx.insert(traces)
      .values({
        id,
        workspaceId: row.workspaceId,
        routeId: exists ? row.id : null,
        consumerId: actor.id ?? actor.kind,
        method,
        status: result.status,
        outcome: result.outcome,
        code: result.code,
        requestBytes,
        responseBytes: result.bytes,
        durationMs: result.durationMs,
        startedAt,
      })
      .run();
    tx.run(
      sql`delete from gateway_traces where workspace_id = ${row.workspaceId} and id not in (select id from gateway_traces where workspace_id = ${row.workspaceId} order by started_at desc, id desc limit 1000)`,
    );
  });
  audit({
    action: "gateway.call",
    entityKind: "other",
    entityId: row.id,
    entityName: row.name,
    workspaceId: row.workspaceId,
    actor,
    via: actor.via,
    result: result.outcome === "success" ? "ok" : "denied",
    changes: [],
    meta: {
      traceId: id,
      method,
      status: result.status,
      code: result.code,
      ms: result.durationMs,
      requestBytes,
      responseBytes: result.bytes,
    },
  });
}

const sessionHash = (id: string) => createHash("sha256").update(id).digest("hex");
function requireMcpSession(routeId: string, grantId: string, id: string) {
  const row = getDb()
    .select()
    .from(schema.gatewaySessions)
    .where(
      and(
        eq(schema.gatewaySessions.routeId, routeId),
        eq(schema.gatewaySessions.sessionHash, sessionHash(id)),
      ),
    )
    .get();
  if (!row || row.grantId !== grantId || row.expiresAt <= Date.now())
    throw new GatewayPolicyError("mcp_session", "MCP session not found for this gateway grant", 404);
}
function bindMcpSession(row: RouteRow, grantId: string, expiresAt: number | null, id: string) {
  if (!/^[\x21-\x7e]{1,1024}$/.test(id) || id.includes("[redacted]"))
    throw new GatewayTransportError("mcp_session", "Upstream returned an invalid MCP session ID");
  const now = Date.now();
  getDb().transaction((tx) => {
    tx.run(sql`delete from gateway_sessions where expires_at <= ${now}`);
    const hash = sessionHash(id);
    const existing = tx
      .select()
      .from(schema.gatewaySessions)
      .where(and(eq(schema.gatewaySessions.routeId, row.id), eq(schema.gatewaySessions.sessionHash, hash)))
      .get();
    if (existing && existing.grantId !== grantId)
      throw new GatewayTransportError(
        "mcp_session",
        "Upstream MCP sessions cannot be shared across gateway grants",
      );
    if (!existing)
      tx.insert(schema.gatewaySessions)
        .values({
          routeId: row.id,
          workspaceId: row.workspaceId,
          sessionHash: hash,
          grantId,
          createdAt: now,
          expiresAt: Math.min(expiresAt ?? Infinity, now + 86400000),
        })
        .run();
    tx.run(
      sql`delete from gateway_sessions where workspace_id = ${row.workspaceId} and rowid not in (select rowid from gateway_sessions where workspace_id = ${row.workspaceId} order by created_at desc, rowid desc limit 1000)`,
    );
  });
}

async function readGatewayBody(req: Request, limit: number): Promise<Buffer> {
  if (Number(req.headers.get("content-length")) > limit)
    throw new HttpError(413, "Gateway request is too large");
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw new HttpError(413, "Gateway request is too large");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks);
}

/** Native HTTP endpoint; Postbox identity and broker grant both authorize every request. */
export async function invokeGateway(req: Request, id: string, path: string[]): Promise<Response> {
  let row = getGatewayRoute(id, "run");
  const actor = actorOf(currentCaller());
  const started = Date.now();
  let requestBytes = 0,
    recorded = false;
  const complete = (result: GatewayCompletion) => {
    if (!recorded) {
      recorded = true;
      recordTrace(row, req.method, requestBytes, started, actor, result);
    }
  };
  try {
    if (currentCaller()?.kind === "open")
      throw new GatewayPolicyError(
        "authentication",
        "Configure account or recovery authentication before using the gateway",
        503,
      );
    if (process.env.GATEWAY_ENABLED !== "true")
      throw new GatewayPolicyError("unavailable", "Gateway is not enabled on this server", 503);
    const raw = await readGatewayBody(req, row.policy.maxRequestBytes);
    requestBytes = raw.length;
    // Re-read after awaiting the incoming body so policy changes take effect before forwarding.
    row = getGatewayRoute(id, "run");
    const relativePath = "/" + path.map(encodeURIComponent).join("/") + new URL(req.url).search;
    const body = applyGatewayPolicy(row, req.method, relativePath, raw);
    if (row.kind === "mcp") {
      const origin = req.headers.get("origin");
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === requestHost(req.headers, req.url);
        } catch {
          /* Invalid origins are rejected. */
        }
        if (!sameHost && !mcpSettings().allowedOrigins.includes(origin.replace(/\/$/, "")))
          throw new GatewayPolicyError("origin", "Cross-origin MCP requests are not allowed");
      }
      if (
        req.method === "POST" &&
        req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
      )
        throw new GatewayPolicyError("mcp_content_type", "MCP requests require application/json", 415);
      validateMcpMetadata(req.headers, raw);
    }

    const grantId = req.headers.get("x-postbox-grant");
    if (!grantId) throw new GatewayPolicyError("grant", "X-Postbox-Grant is required", 401);
    const headers: Record<string, string> = {};
    const deniedHeaders = new Set([
      "authorization",
      "cookie",
      "host",
      "x-postbox-grant",
      "proxy-authorization",
      "content-length",
      "connection",
      "transfer-encoding",
    ]);
    for (const name of row.policy.forwardHeaders) {
      const lower = name.toLowerCase();
      if (row.kind === "mcp" && lower === "mcp-param-*") {
        for (const [key, value] of req.headers) if (key.startsWith("mcp-param-")) headers[key] = value;
        continue;
      }
      if (deniedHeaders.has(lower)) continue;
      const value = req.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const prepared = broker.prepareBrokerCall(
      grantId,
      {
        method: req.method as (typeof METHODS)[number],
        path: upstreamPath(row.upstreamPrefix, relativePath),
        headers,
        bodyBase64: body.length ? body.toString("base64") : undefined,
      },
      { apiId: row.apiId, auditPath: "/gateway", maxRequestBytes: row.policy.maxRequestBytes },
    );
    const mcpSession = row.kind === "mcp" ? req.headers.get("mcp-session-id") : null;
    if (mcpSession) requireMcpSession(row.id, grantId, mcpSession);
    const domainError = checkVaultDomains(prepared.guarded, {
      url: prepared.attached.url,
      headers: prepared.attached.headers,
      body,
    });
    if (domainError)
      throw new GatewayPolicyError(
        "credential_domain",
        "Provider credential is not allowed for this destination",
      );
    reserveGatewayQuota(id);
    const upstream = await openGatewayStream({
      url: prepared.attached.url,
      method: req.method,
      headers: prepared.attached.headers,
      body,
      policy: getPolicy(),
      secrets: prepared.sensitive,
      timeoutMs: row.policy.timeoutMs,
      maxResponseBytes: row.policy.maxResponseBytes,
      allowStreaming: row.policy.allowStreaming,
      signal: req.signal,
      onComplete: complete,
      onHeaders: (status, headers) => {
        if (row.kind !== "mcp") return;
        if (mcpSession && (req.method === "DELETE" || status === 404)) {
          getDb()
            .delete(schema.gatewaySessions)
            .where(
              and(
                eq(schema.gatewaySessions.routeId, row.id),
                eq(schema.gatewaySessions.sessionHash, sessionHash(mcpSession)),
              ),
            )
            .run();
          if (req.method === "DELETE") return;
        }
        const id = headers.find(([name]) => name.toLowerCase() === "mcp-session-id")?.[1];
        if (id && status < 400) bindMcpSession(row, grantId, prepared.row.expiresAt, id);
      },
    });
    getDb()
      .update(schema.brokerGrants)
      .set({ lastUsedAt: Date.now(), useCount: sql`${schema.brokerGrants.useCount} + 1` })
      .where(eq(schema.brokerGrants.id, grantId))
      .run();
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-accel-buffering", "no");
    responseHeaders.set("content-security-policy", "sandbox; default-src 'none'");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const known = error instanceof GatewayPolicyError || error instanceof GatewayTransportError;
    const status = known ? error.status : isHttpError(error) ? error.status : 502;
    const code = known ? error.code : status === 404 ? "access" : status === 413 ? "request_size" : "denied";
    complete({
      status,
      outcome: status === 429 ? "limited" : "error",
      code,
      bytes: 0,
      durationMs: Date.now() - started,
    });
    const headers = new Headers({ "cache-control": "no-store" });
    if (error instanceof QuotaError) headers.set("retry-after", String(error.retryAfter));
    return Response.json(
      { error: known || isHttpError(error) ? error.message : "Gateway request failed", code },
      { status, headers },
    );
  }
}
