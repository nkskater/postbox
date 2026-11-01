/**
 * Incoming webhook listeners: configuration, the public ingest path and bounded event storage.
 *
 * A request to `/hook/<token>` is hostile input. It is size-limited before it is read, rate-limited
 * per listener, verified against the listener's settings and stored with credentials redacted.
 * The response is whatever the owner configured; nothing from the request is ever echoed back.
 * Forwarding and replay go through the outbound host policy and only replay is ever user-driven.
 */
import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { sendRequest, RequestError } from "@/core/http/engine";
import { HostPolicyError } from "@/core/http/policy";
import { DEFAULT_SETTINGS } from "@/core/types";
import {
  DEFAULT_RATE_PER_MINUTE,
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_LISTENER,
  MAX_LISTENERS_PER_WORKSPACE,
  MAX_PATH_CHARS,
  MAX_RATE_PER_MINUTE,
  MAX_RESPONSE_BODY_CHARS,
  hashToken,
  isHeaderName,
  isListenerToken,
  isSafeContentType,
  newListenerToken,
  storableBody,
  storableHeaders,
  verifyIncoming,
  type SignatureResult,
  type VerificationConfig,
} from "@/core/hook-listeners";
import { checkTargetUrl } from "@/core/webhooks";
import { getPolicy } from "./context";
import { getDb, schema } from "./db";
import type { HookEventRow, HookListenerRow } from "./db/schema";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { HttpError, notFound } from "./errors";

const { hookListeners, hookEvents } = schema;
const FORWARD_TIMEOUT_MS = 10_000;
const MAX_FORWARDS_IN_FLIGHT = 10;
const limiter = new FixedWindowLimiter();
let forwardsInFlight = 0;

// ------------------------------------------------------------------ configuration

const headerName = z.string().trim().refine(isHeaderName, "Not a valid header name");
const verificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("token"), header: headerName }).strict(),
  z
    .object({
      type: z.literal("hmac"),
      header: headerName,
      encoding: z.enum(["hex", "base64"]).default("hex"),
      prefix: z.string().max(40).default(""),
    })
    .strict(),
  z.object({ type: z.literal("timestamped"), header: headerName }).strict(),
]);

const responseSchema = z
  .object({
    status: z
      .number()
      .int()
      .min(200)
      .max(599)
      .refine((status) => status < 300 || status >= 400, "Redirect responses are not supported"),
    contentType: z.string().trim().refine(isSafeContentType, "Not a valid content type"),
    body: z.string().max(MAX_RESPONSE_BODY_CHARS),
  })
  .strict();

export const listenerInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    verification: verificationSchema.default({ type: "none" }),
    /** Needed whenever verification is on. Write-only. */
    secret: z.string().min(1).max(500).optional(),
    response: responseSchema.default({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
    forwardUrl: z.string().trim().max(2000).nullable().optional(),
    ratePerMinute: z.number().int().min(1).max(MAX_RATE_PER_MINUTE).default(DEFAULT_RATE_PER_MINUTE),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verification.type !== "none" && !value.secret)
      ctx.addIssue({ code: "custom", path: ["secret"], message: "A secret is needed to verify requests" });
  });
export const listenerPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    verification: verificationSchema,
    secret: z.string().min(1).max(500),
    response: responseSchema,
    forwardUrl: z.string().trim().max(2000).nullable(),
    ratePerMinute: z.number().int().min(1).max(MAX_RATE_PER_MINUTE),
    status: z.enum(["active", "paused", "revoked"]),
  })
  .partial()
  .strict();

export interface ListenerView {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "paused" | "revoked";
  /** Last characters of the token. The full URL is only shown when created or rotated. */
  tokenHint: string;
  verification: VerificationConfig;
  hasSecret: boolean;
  response: { status: number; contentType: string; body: string };
  forwardUrl: string | null;
  ratePerMinute: number;
  receivedCount: number;
  lastReceivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const view = (row: HookListenerRow): ListenerView => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  status: row.status as ListenerView["status"],
  tokenHint: row.tokenHint,
  verification: JSON.parse(row.verification) as VerificationConfig,
  hasSecret: row.secret.length > 0,
  response: { status: row.responseStatus, contentType: row.responseContentType, body: row.responseBody },
  forwardUrl: row.forwardUrl,
  ratePerMinute: row.ratePerMinute,
  receivedCount: row.receivedCount,
  lastReceivedAt: row.lastReceivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function assertForwardTarget(value: string | null | undefined) {
  if (!value) return;
  const problem = checkTargetUrl(value);
  if (problem) throw new HttpError(400, problem);
  const blocked = getPolicy().check(new URL(value).hostname);
  if (blocked)
    throw new HttpError(400, `This server's outbound policy does not allow that address. ${blocked}`);
}

function row(id: string): HookListenerRow {
  const found = getDb().select().from(hookListeners).where(eq(hookListeners.id, id)).get();
  if (!found) throw notFound("Listener");
  return found;
}

export const listListeners = (workspaceId: string): ListenerView[] =>
  getDb()
    .select()
    .from(hookListeners)
    .where(eq(hookListeners.workspaceId, workspaceId))
    .orderBy(asc(hookListeners.createdAt))
    .all()
    .map(view);

export const getListener = (id: string): ListenerView => view(row(id));

/** The token is part of the URL and is returned only here and when rotated. */
export function createListener(workspaceId: string, input: z.infer<typeof listenerInput>) {
  assertForwardTarget(input.forwardUrl);
  const db = getDb();
  const existing = db
    .select({ n: count() })
    .from(hookListeners)
    .where(eq(hookListeners.workspaceId, workspaceId))
    .get();
  if ((existing?.n ?? 0) >= MAX_LISTENERS_PER_WORKSPACE)
    throw new HttpError(400, `A workspace can have at most ${MAX_LISTENERS_PER_WORKSPACE} listeners`);
  const token = newListenerToken();
  const now = Date.now();
  const created: HookListenerRow = {
    id: newId(),
    workspaceId,
    name: input.name,
    status: "active",
    tokenHash: hashToken(token),
    tokenHint: token.slice(-4),
    verification: JSON.stringify(input.verification),
    secret: input.secret ?? "",
    responseStatus: input.response.status,
    responseContentType: input.response.contentType,
    responseBody: input.response.body,
    forwardUrl: input.forwardUrl || null,
    ratePerMinute: input.ratePerMinute,
    receivedCount: 0,
    lastReceivedAt: null,
    createdBy: actorId() ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(hookListeners).values(created).run();
  return { ...view(created), token, path: `/hook/${token}` };
}

export function updateListener(id: string, patch: z.infer<typeof listenerPatch>) {
  const current = row(id);
  if (current.status === "revoked") throw new HttpError(409, "A revoked listener cannot be changed");
  if (patch.forwardUrl !== undefined) assertForwardTarget(patch.forwardUrl);
  const verification = patch.verification ?? (JSON.parse(current.verification) as VerificationConfig);
  const secret = patch.secret ?? current.secret;
  if (verification.type !== "none" && !secret)
    throw new HttpError(400, "A secret is needed to verify requests");
  getDb()
    .update(hookListeners)
    .set({
      name: patch.name ?? current.name,
      status: patch.status ?? current.status,
      verification: JSON.stringify(verification),
      secret: verification.type === "none" ? "" : secret,
      responseStatus: patch.response?.status ?? current.responseStatus,
      responseContentType: patch.response?.contentType ?? current.responseContentType,
      responseBody: patch.response?.body ?? current.responseBody,
      forwardUrl: patch.forwardUrl === undefined ? current.forwardUrl : patch.forwardUrl || null,
      ratePerMinute: patch.ratePerMinute ?? current.ratePerMinute,
      updatedAt: Date.now(),
    })
    .where(eq(hookListeners.id, id))
    .run();
  limiter.forget(id);
  return view(row(id));
}

/** Replace the URL. The old one stops working immediately. */
export function rotateListenerToken(id: string) {
  const current = row(id);
  if (current.status === "revoked") throw new HttpError(409, "A revoked listener cannot be changed");
  const token = newListenerToken();
  getDb()
    .update(hookListeners)
    .set({ tokenHash: hashToken(token), tokenHint: token.slice(-4), updatedAt: Date.now() })
    .where(eq(hookListeners.id, id))
    .run();
  return { ...view(row(id)), token, path: `/hook/${token}` };
}

export function deleteListener(id: string) {
  row(id);
  getDb().delete(hookListeners).where(eq(hookListeners.id, id)).run();
  limiter.forget(id);
}

// ------------------------------------------------------------------ events

export interface EventView {
  id: string;
  listenerId: string;
  receivedAt: number;
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
  bodyBytes: number;
  signature: SignatureResult;
  responseStatus: number;
  forwardStatus: number | null;
  forwardError: string | null;
  forwardedAt: number | null;
  replays: number;
}
const eventView = (event: HookEventRow): EventView => ({
  id: event.id,
  listenerId: event.listenerId,
  receivedAt: event.receivedAt,
  method: event.method,
  path: event.path,
  query: event.query,
  headers: JSON.parse(event.headers) as [string, string][],
  bodyBytes: event.bodyBytes,
  signature: event.signature as SignatureResult,
  responseStatus: event.responseStatus,
  forwardStatus: event.forwardStatus,
  forwardError: event.forwardError,
  forwardedAt: event.forwardedAt,
  replays: event.replays,
});

export function listEvents(listenerId: string, limit = 50): EventView[] {
  row(listenerId);
  return getDb()
    .select()
    .from(hookEvents)
    .where(eq(hookEvents.listenerId, listenerId))
    .orderBy(desc(hookEvents.receivedAt), desc(hookEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all()
    .map(eventView);
}

/** One event with its body, which lists leave out. */
export function getEvent(listenerId: string, eventId: string) {
  const event = findEvent(listenerId, eventId);
  return { ...eventView(event), body: event.body, bodyEncoding: event.bodyEncoding };
}

function findEvent(listenerId: string, eventId: string): HookEventRow {
  row(listenerId);
  const event = getDb()
    .select()
    .from(hookEvents)
    .where(and(eq(hookEvents.id, eventId), eq(hookEvents.listenerId, listenerId)))
    .get();
  if (!event) throw notFound("Event");
  return event;
}

export function clearEvents(listenerId: string) {
  row(listenerId);
  getDb().delete(hookEvents).where(eq(hookEvents.listenerId, listenerId)).run();
}

/** Drop events past their age limit (0 keeps them) and any beyond the per-listener cap. */
export function pruneHookEvents(retentionDays: number, now = Date.now()) {
  if (retentionDays > 0)
    getDb()
      .delete(hookEvents)
      .where(lt(hookEvents.receivedAt, now - retentionDays * 86_400_000))
      .run();
}

function trimToCap(listenerId: string) {
  const db = getDb();
  const stale = db
    .select({ id: hookEvents.id })
    .from(hookEvents)
    .where(eq(hookEvents.listenerId, listenerId))
    .orderBy(desc(hookEvents.receivedAt), desc(hookEvents.id))
    .limit(1000)
    .offset(MAX_EVENTS_PER_LISTENER)
    .all()
    .map((entry) => entry.id);
  if (stale.length) db.delete(hookEvents).where(inArray(hookEvents.id, stale)).run();
}

// ------------------------------------------------------------------ ingest

export interface IncomingRequest {
  method: string;
  /** Path after `/hook/<token>`, starting with `/` or empty. */
  path: string;
  query: string;
  headers: [string, string][];
  body: Buffer;
}
export interface IngestResult {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const failure = (status: number, message: string, headers?: Record<string, string>): IngestResult => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ error: message }),
  headers,
});

/** Read a request body, failing with 413 as soon as it exceeds the limit. */
export async function readIncomingBody(request: Request, limit = MAX_BODY_BYTES): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > limit) throw new HttpError(413, "Body too large");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw new HttpError(413, "Body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function ingest(token: string, request: IncomingRequest, now = Date.now()): IngestResult {
  // Unknown, malformed and revoked tokens look identical, so tokens cannot be probed.
  const notHere = failure(404, "Not found");
  if (!isListenerToken(token)) return notHere;
  const db = getDb();
  const listener = db
    .select()
    .from(hookListeners)
    .where(eq(hookListeners.tokenHash, hashToken(token)))
    .get();
  if (!listener || listener.status === "revoked") return notHere;
  if (listener.status === "paused") return failure(503, "This listener is paused", { "Retry-After": "300" });
  const decision = limiter.hit(listener.id, listener.ratePerMinute, 60_000, now);
  if (!decision.allowed)
    return failure(429, "Too many requests", { "Retry-After": String(decision.resetSeconds) });

  const config = JSON.parse(listener.verification) as VerificationConfig;
  const lowered: Record<string, string> = {};
  for (const [name, value] of request.headers) lowered[name.toLowerCase()] = value;
  const signature = verifyIncoming(config, listener.secret, lowered, request.body, now);
  const rejected = signature === "invalid" || signature === "missing";
  const result: IngestResult = rejected
    ? failure(401, "Signature verification failed")
    : {
        status: listener.responseStatus,
        contentType: listener.responseContentType,
        body: listener.responseBody,
      };

  const stored = storableBody(request.body);
  const eventId = newId();
  db.transaction((tx) => {
    tx.insert(hookEvents)
      .values({
        id: eventId,
        listenerId: listener.id,
        workspaceId: listener.workspaceId,
        receivedAt: now,
        method: request.method.slice(0, 16),
        path: request.path.slice(0, MAX_PATH_CHARS),
        query: request.query.slice(0, MAX_PATH_CHARS),
        headers: JSON.stringify(storableHeaders(request.headers, config)),
        body: stored.text,
        bodyEncoding: stored.encoding,
        bodyBytes: request.body.length,
        signature,
        responseStatus: result.status,
      })
      .run();
    tx.update(hookListeners)
      .set({ receivedCount: sql`${hookListeners.receivedCount} + 1`, lastReceivedAt: now })
      .where(eq(hookListeners.id, listener.id))
      .run();
  });
  trimToCap(listener.id);

  if (!rejected && listener.forwardUrl) void forwardEvent(listener, eventId, listener.forwardUrl, false);
  return result;
}

// ------------------------------------------------------------------ forward and replay

interface ForwardOutcome {
  status: number | null;
  error: string | null;
}

async function send(listener: HookListenerRow, event: HookEventRow, url: string, replay: boolean) {
  const problem = checkTargetUrl(url);
  if (problem) return { status: null, error: problem } satisfies ForwardOutcome;
  const headers = JSON.parse(event.headers) as [string, string][];
  const contentType = headers.find(([name]) => name === "content-type")?.[1];
  const body = event.bodyEncoding === "base64" ? Buffer.from(event.body, "base64") : Buffer.from(event.body);
  try {
    const response = await sendRequest(
      {
        method: ["GET", "HEAD"].includes(event.method) ? "POST" : event.method,
        url,
        headers: [
          ...(contentType ? [["Content-Type", contentType] as [string, string]] : []),
          ["User-Agent", "Postbox-Listener/1"],
          ["Postbox-Listener", listener.id],
          ["Postbox-Event-Id", event.id],
          ...(replay ? [["Postbox-Replay", "true"] as [string, string]] : []),
        ],
        body,
        settings: {
          ...DEFAULT_SETTINGS,
          followRedirects: false,
          timeoutMs: FORWARD_TIMEOUT_MS,
          useCookieJar: false,
        },
      },
      { policy: getPolicy(), maxBodyBytes: 64 * 1024 },
    );
    return { status: response.status, error: null } satisfies ForwardOutcome;
  } catch (error) {
    if (error instanceof HostPolicyError)
      return { status: null, error: `Blocked by outbound policy: ${error.message}`.slice(0, 500) };
    const message = error instanceof RequestError ? error.message : (error as Error).message;
    return { status: null, error: message.slice(0, 500) } satisfies ForwardOutcome;
  }
}

async function forwardEvent(listener: HookListenerRow, eventId: string, url: string, replay: boolean) {
  const db = getDb();
  if (forwardsInFlight >= MAX_FORWARDS_IN_FLIGHT) {
    db.update(hookEvents)
      .set({ forwardError: "Skipped: too many forwards in flight", forwardedAt: Date.now() })
      .where(eq(hookEvents.id, eventId))
      .run();
    return { status: null, error: "Skipped: too many forwards in flight" };
  }
  forwardsInFlight++;
  try {
    const event = db.select().from(hookEvents).where(eq(hookEvents.id, eventId)).get();
    if (!event) return { status: null, error: "Event no longer exists" };
    const outcome = await send(listener, event, url, replay);
    // The listener or event may have been deleted while the request was in flight.
    try {
      db.update(hookEvents)
        .set({
          forwardStatus: outcome.status,
          forwardError: outcome.error,
          forwardedAt: Date.now(),
          ...(replay ? { replays: sql`${hookEvents.replays} + 1` } : {}),
        })
        .where(eq(hookEvents.id, eventId))
        .run();
    } catch {
      /* database closed or row gone */
    }
    return outcome;
  } finally {
    forwardsInFlight--;
  }
}

/** Send a stored event again. Only ever called for a user's explicit request. */
export async function replayEvent(listenerId: string, eventId: string, target?: string | null) {
  const listener = row(listenerId);
  findEvent(listenerId, eventId);
  const url = target || listener.forwardUrl;
  if (!url) throw new HttpError(400, "Choose where to send it: set a forward URL or pass `url`");
  assertForwardTarget(url);
  return forwardEvent(listener, eventId, url, true);
}
