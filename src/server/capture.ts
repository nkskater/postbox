/**
 * Traffic capture: recording sessions, the relay that records, and turning recordings into requests.
 *
 * The relay (`/capture/<token>/<absolute URL>`) is hostile-input territory. The token is the only
 * credential, so unknown, malformed and stopped sessions look identical. Every target goes through
 * the outbound host policy; https targets need the session owner's explicit consent; nothing is
 * stored before credentials are removed. Stored recordings are only ever replayed by a user
 * turning them into requests.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MAX_ENTRIES_PER_SESSION,
  MAX_RELAY_REQUEST_BYTES,
  MAX_SESSIONS_PER_WORKSPACE,
  SecretSet,
  captureBody,
  checkCaptureTarget,
  forwardableHeaders,
  hashToken,
  headerValue,
  isCaptureToken,
  newCaptureToken,
  normalizeHostFilter,
  redactHeaders,
  redactUrl,
  toHar,
  type CapturedBody,
  type CapturedExchange,
  type StoredEntry,
} from "@/core/capture";
import { importHar } from "@/core/convert/har";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { RequestError, sendRequest } from "@/core/http/engine";
import { HostPolicyError } from "@/core/http/policy";
import { DEFAULT_SETTINGS } from "@/core/types";
import { audit } from "./audit";
import { actorId } from "./authorize";
import { getPolicy } from "./context";
import { getDb, schema } from "./db";
import type { CaptureEntryRow, CaptureSessionRow } from "./db/schema";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";

const { captureSessions, captureEntries } = schema;
const RELAY_TIMEOUT_MS = 30_000;
const RELAY_RESPONSE_BYTES = 5 * 1024 * 1024;
const RELAY_PER_MINUTE = 600;
const limiter = new FixedWindowLimiter();
const BLOCKED_RELAY_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "service-worker-allowed",
  "refresh",
  "content-security-policy",
  "content-security-policy-report-only",
  "report-to",
  "reporting-endpoints",
  "nel",
]);

// ------------------------------------------------------------------ sessions

const hostList = z.array(z.string().trim().min(1).max(253)).max(20);
export const sessionInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    hosts: hostList.default([]),
    captureCookies: z.boolean().default(false),
    /** Must be true to record https:// targets. Recorded as the person's consent. */
    allowHttps: z.boolean().default(false),
  })
  .strict();
export const sessionPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    hosts: hostList,
    captureCookies: z.boolean(),
    allowHttps: z.boolean(),
    status: z.enum(["recording", "paused", "stopped"]),
  })
  .partial()
  .strict();

export interface SessionView {
  id: string;
  workspaceId: string;
  name: string;
  status: "recording" | "paused" | "stopped";
  tokenHint: string;
  allowHttps: boolean;
  httpsConsentAt: number | null;
  captureCookies: boolean;
  hosts: string[];
  entryCount: number;
  lastCapturedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
const view = (row: CaptureSessionRow): SessionView => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  status: row.status as SessionView["status"],
  tokenHint: row.tokenHint,
  allowHttps: row.allowHttps,
  httpsConsentAt: row.httpsConsentAt,
  captureCookies: row.captureCookies,
  hosts: JSON.parse(row.hosts) as string[],
  entryCount: row.entryCount,
  lastCapturedAt: row.lastCapturedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function row(id: string): CaptureSessionRow {
  const found = getDb().select().from(captureSessions).where(eq(captureSessions.id, id)).get();
  if (!found) throw notFound("Capture session");
  return found;
}

function filters(values: string[]): string[] {
  try {
    return normalizeHostFilter(values);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

export const listSessions = (workspaceId: string): SessionView[] =>
  getDb()
    .select()
    .from(captureSessions)
    .where(eq(captureSessions.workspaceId, workspaceId))
    .orderBy(desc(captureSessions.createdAt))
    .all()
    .map(view);

export const getSession = (id: string): SessionView => view(row(id));

const relayPath = (token: string) => `/capture/${token}/`;

/** The token is part of the URL and is returned only here and when rotated. */
export function createSession(workspaceId: string, input: z.infer<typeof sessionInput>) {
  repo.requireWorkspace(workspaceId);
  const db = getDb();
  const existing = db
    .select({ n: count() })
    .from(captureSessions)
    .where(eq(captureSessions.workspaceId, workspaceId))
    .get();
  if ((existing?.n ?? 0) >= MAX_SESSIONS_PER_WORKSPACE)
    throw new HttpError(400, `A workspace can have at most ${MAX_SESSIONS_PER_WORKSPACE} capture sessions`);
  const token = newCaptureToken();
  const at = Date.now();
  const created: CaptureSessionRow = {
    id: newId(),
    workspaceId,
    name: input.name,
    status: "recording",
    tokenHash: hashToken(token),
    tokenHint: token.slice(-4),
    allowHttps: input.allowHttps,
    httpsConsentBy: input.allowHttps ? (actorId() ?? null) : null,
    httpsConsentAt: input.allowHttps ? at : null,
    captureCookies: input.captureCookies,
    hosts: JSON.stringify(filters(input.hosts)),
    entryCount: 0,
    lastCapturedAt: null,
    createdBy: actorId() ?? null,
    createdAt: at,
    updatedAt: at,
  };
  db.insert(captureSessions).values(created).run();
  audit({
    action: "capture.session.create",
    entityKind: "captureSession",
    entityId: created.id,
    entityName: created.name,
    workspaceId,
    changes: [],
    meta: { allowHttps: created.allowHttps, captureCookies: created.captureCookies },
  });
  return { ...view(created), token, path: relayPath(token) };
}

export function updateSession(id: string, patch: z.infer<typeof sessionPatch>) {
  const current = row(id);
  if (current.status === "stopped" && patch.status && patch.status !== "stopped")
    throw new HttpError(409, "A stopped session cannot record again. Start a new session.");
  const at = Date.now();
  const consent = patch.allowHttps === undefined ? current.allowHttps : patch.allowHttps;
  getDb()
    .update(captureSessions)
    .set({
      name: patch.name ?? current.name,
      status: patch.status ?? current.status,
      hosts: patch.hosts ? JSON.stringify(filters(patch.hosts)) : current.hosts,
      captureCookies: patch.captureCookies ?? current.captureCookies,
      allowHttps: consent,
      httpsConsentBy: consent ? (current.allowHttps ? current.httpsConsentBy : (actorId() ?? null)) : null,
      httpsConsentAt: consent ? (current.allowHttps ? current.httpsConsentAt : at) : null,
      updatedAt: at,
    })
    .where(eq(captureSessions.id, id))
    .run();
  limiter.forget(id);
  audit({
    action: "capture.session.update",
    entityKind: "captureSession",
    entityId: id,
    entityName: patch.name ?? current.name,
    workspaceId: current.workspaceId,
    changes: [],
    meta: { fields: Object.keys(patch) },
  });
  return view(row(id));
}

/** Replace the URL. The old one stops working immediately. */
export function rotateSessionToken(id: string) {
  const current = row(id);
  if (current.status === "stopped") throw new HttpError(409, "A stopped session cannot be changed");
  const token = newCaptureToken();
  getDb()
    .update(captureSessions)
    .set({ tokenHash: hashToken(token), tokenHint: token.slice(-4), updatedAt: Date.now() })
    .where(eq(captureSessions.id, id))
    .run();
  audit({
    action: "capture.session.rotate",
    entityKind: "captureSession",
    entityId: id,
    entityName: current.name,
    workspaceId: current.workspaceId,
    changes: [],
  });
  return { ...view(row(id)), token, path: relayPath(token) };
}

export function deleteSession(id: string) {
  const current = row(id);
  getDb().delete(captureSessions).where(eq(captureSessions.id, id)).run();
  limiter.forget(id);
  audit({
    action: "capture.session.delete",
    entityKind: "captureSession",
    entityId: id,
    entityName: current.name,
    workspaceId: current.workspaceId,
    changes: [],
  });
}

// ------------------------------------------------------------------ entries

export interface EntrySummary {
  id: string;
  startedAt: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  error: string | null;
  redactions: number;
  importedAt: number | null;
}
const body = (value: string) => JSON.parse(value) as CapturedBody;
const summary = (entry: CaptureEntryRow): EntrySummary => ({
  id: entry.id,
  startedAt: entry.startedAt,
  method: entry.method,
  url: entry.url,
  status: entry.status,
  durationMs: entry.durationMs,
  requestBytes: body(entry.requestBody).bytes,
  responseBytes: body(entry.responseBody).bytes,
  error: entry.error,
  redactions: entry.redactions,
  importedAt: entry.importedAt,
});
const stored = (entry: CaptureEntryRow): StoredEntry => ({
  id: entry.id,
  startedAt: entry.startedAt,
  method: entry.method,
  url: entry.url,
  requestHeaders: JSON.parse(entry.requestHeaders) as [string, string][],
  requestBody: body(entry.requestBody),
  status: entry.status,
  statusText: entry.statusText,
  responseHeaders: JSON.parse(entry.responseHeaders) as [string, string][],
  responseBody: body(entry.responseBody),
  durationMs: entry.durationMs,
});

export function listEntries(sessionId: string, limit = 100): EntrySummary[] {
  row(sessionId);
  return getDb()
    .select()
    .from(captureEntries)
    .where(eq(captureEntries.sessionId, sessionId))
    .orderBy(asc(captureEntries.startedAt), asc(captureEntries.id))
    .limit(Math.min(Math.max(limit, 1), MAX_ENTRIES_PER_SESSION))
    .all()
    .map(summary);
}

function findEntry(sessionId: string, entryId: string): CaptureEntryRow {
  row(sessionId);
  const found = getDb()
    .select()
    .from(captureEntries)
    .where(and(eq(captureEntries.id, entryId), eq(captureEntries.sessionId, sessionId)))
    .get();
  if (!found) throw notFound("Capture entry");
  return found;
}

/** One entry with headers and bodies, which lists leave out. */
export const getEntry = (sessionId: string, entryId: string) => {
  const entry = findEntry(sessionId, entryId);
  return { ...summary(entry), ...stored(entry), error: entry.error };
};

export function deleteEntries(sessionId: string, entryIds?: string[]) {
  row(sessionId);
  const db = getDb();
  const where = entryIds?.length
    ? and(eq(captureEntries.sessionId, sessionId), inArray(captureEntries.id, entryIds))
    : eq(captureEntries.sessionId, sessionId);
  db.delete(captureEntries).where(where).run();
  recount(sessionId);
}

function recount(sessionId: string) {
  const n = getDb()
    .select({ n: count() })
    .from(captureEntries)
    .where(eq(captureEntries.sessionId, sessionId))
    .get()?.n;
  getDb()
    .update(captureSessions)
    .set({ entryCount: n ?? 0 })
    .where(eq(captureSessions.id, sessionId))
    .run();
}

/** Drop recordings past their age limit (0 keeps them) and fix the session counters. */
export function pruneCaptures(retentionDays: number, now = Date.now()) {
  if (retentionDays <= 0) return;
  const db = getDb();
  const cutoff = now - retentionDays * 86_400_000;
  const affected = db
    .selectDistinct({ id: captureEntries.sessionId })
    .from(captureEntries)
    .where(lt(captureEntries.startedAt, cutoff))
    .all();
  if (!affected.length) return;
  db.delete(captureEntries).where(lt(captureEntries.startedAt, cutoff)).run();
  for (const { id } of affected) recount(id);
}

/** Store one exchange with credentials removed. Returns how many values were redacted. */
function store(
  session: CaptureSessionRow,
  exchange: CapturedExchange,
  requestBody: Buffer,
  responseBody: Buffer,
) {
  const secrets = new SecretSet();
  const options = { keepCookies: session.captureCookies };
  const url = redactUrl(exchange.url, secrets);
  const requestHeaders = redactHeaders(exchange.requestHeaders, options, secrets);
  const responseHeaders = redactHeaders(exchange.responseHeaders, options, secrets);
  // Bodies are processed last so credentials seen in headers and the URL are removed from them too.
  const request = captureBody(requestBody, headerValue(exchange.requestHeaders, "content-type"), secrets);
  const response = captureBody(responseBody, headerValue(exchange.responseHeaders, "content-type"), secrets);
  const db = getDb();
  const id = newId();
  db.transaction((tx) => {
    tx.insert(captureEntries)
      .values({
        id,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        startedAt: exchange.startedAt,
        method: exchange.method.slice(0, 16),
        url,
        requestHeaders: JSON.stringify(requestHeaders),
        requestBody: JSON.stringify(request),
        status: exchange.status,
        statusText: exchange.statusText.slice(0, 200),
        responseHeaders: JSON.stringify(responseHeaders),
        responseBody: JSON.stringify(response),
        durationMs: exchange.durationMs,
        error: exchange.error?.slice(0, 500) ?? null,
        redactions: secrets.size,
      })
      .run();
    tx.update(captureSessions)
      .set({ entryCount: sql`${captureSessions.entryCount} + 1`, lastCapturedAt: exchange.startedAt })
      .where(eq(captureSessions.id, session.id))
      .run();
  });
  trimToCap(session.id);
  return id;
}

function trimToCap(sessionId: string) {
  const db = getDb();
  const stale = db
    .select({ id: captureEntries.id })
    .from(captureEntries)
    .where(eq(captureEntries.sessionId, sessionId))
    .orderBy(desc(captureEntries.startedAt), desc(captureEntries.id))
    .limit(1000)
    .offset(MAX_ENTRIES_PER_SESSION)
    .all()
    .map((entry) => entry.id);
  if (stale.length) {
    db.delete(captureEntries).where(inArray(captureEntries.id, stale)).run();
    recount(sessionId);
  }
}

// ------------------------------------------------------------------ relay

export interface RelayRequest {
  method: string;
  /** The absolute URL to record, taken from the path after the token. */
  target: string;
  headers: [string, string][];
  body: Buffer;
}
export interface RelayResult {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

const failure = (status: number, message: string, headers: [string, string][] = []): RelayResult => ({
  status,
  headers: [["Content-Type", "application/json"], ...headers],
  body: Buffer.from(JSON.stringify({ error: message })),
});

export async function relay(token: string, request: RelayRequest, now = Date.now()): Promise<RelayResult> {
  // Unknown, malformed and stopped tokens look identical, so tokens cannot be probed.
  const notHere = failure(404, "Not found");
  if (!isCaptureToken(token)) return notHere;
  const session = getDb()
    .select()
    .from(captureSessions)
    .where(eq(captureSessions.tokenHash, hashToken(token)))
    .get();
  if (!session || session.status === "stopped") return notHere;
  if (session.status === "paused")
    return failure(503, "This capture session is paused", [["Retry-After", "60"]]);
  const decision = limiter.hit(session.id, RELAY_PER_MINUTE, 60_000, now);
  if (!decision.allowed)
    return failure(429, "Too many requests", [["Retry-After", String(decision.resetSeconds)]]);

  const hosts = JSON.parse(session.hosts) as string[];
  const problem = checkCaptureTarget(request.target, { allowHttps: session.allowHttps, hosts });
  if (problem) return failure(403, problem);
  if (request.body.length > MAX_RELAY_REQUEST_BYTES) return failure(413, "Request body too large");

  const forward = forwardableHeaders(request.headers, { postboxToken: process.env.POSTBOX_TOKEN });
  let outcome: CapturedExchange = {
    method: request.method,
    url: request.target,
    requestHeaders: forward,
    requestBody: { text: "", encoding: "empty", bytes: 0, truncated: false },
    status: null,
    statusText: "",
    responseHeaders: [],
    responseBody: { text: "", encoding: "empty", bytes: 0, truncated: false },
    durationMs: null,
    startedAt: now,
    error: null,
  };
  const started = performance.now();
  try {
    const response = await sendRequest(
      {
        method: request.method,
        url: request.target,
        headers: forward,
        body: request.body.length ? request.body : undefined,
        settings: {
          ...DEFAULT_SETTINGS,
          followRedirects: false,
          timeoutMs: RELAY_TIMEOUT_MS,
          useCookieJar: false,
        },
      },
      { policy: getPolicy(), maxBodyBytes: RELAY_RESPONSE_BYTES },
    );
    const raw = Buffer.from(response.bodyBase64, "base64");
    outcome = {
      ...outcome,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: response.headers,
      durationMs: Math.round(performance.now() - started),
    };
    store(session, outcome, request.body, raw);
    // The bytes are decoded already, so encoding and length headers would be wrong.
    const headers = response.headers.filter(
      ([name]) => !BLOCKED_RELAY_RESPONSE_HEADERS.has(name.toLowerCase()),
    );
    return { status: response.status, headers, body: raw };
  } catch (error) {
    const message =
      error instanceof HostPolicyError
        ? `Blocked by outbound policy: ${error.message}`
        : error instanceof RequestError
          ? error.message
          : (error as Error).message;
    outcome = { ...outcome, error: message, durationMs: Math.round(performance.now() - started) };
    try {
      store(session, outcome, request.body, Buffer.alloc(0));
    } catch {
      /* the target URL was unusable; nothing to record */
    }
    return failure(error instanceof HostPolicyError ? 403 : 502, message.slice(0, 300));
  }
}

/** Read a request body, failing with 413 as soon as it exceeds the limit. */
export async function readRelayBody(request: Request, limit = MAX_RELAY_REQUEST_BYTES): Promise<Buffer> {
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

// ------------------------------------------------------------------ HAR in

const pair = z.object({ name: z.string(), value: z.string().default("") });
const harEntry = z.object({
  startedDateTime: z.string().optional(),
  time: z.number().optional(),
  request: z.object({
    method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    url: z.string(),
    headers: z.array(pair).default([]),
    postData: z.object({ mimeType: z.string().default(""), text: z.string().optional() }).optional(),
  }),
  response: z
    .object({
      status: z.number().int().min(0).max(599),
      statusText: z.string().default(""),
      headers: z.array(pair).default([]),
      content: z.object({ mimeType: z.string().default(""), text: z.string().optional() }).optional(),
    })
    .optional(),
});
const harFile = z.object({ log: z.object({ entries: z.array(z.unknown()).max(MAX_ENTRIES_PER_SESSION) }) });

/** Add the entries of a HAR file (from a browser, mitmproxy, curl --trace and so on) to a session. */
export function addHarEntries(sessionId: string, har: unknown) {
  const session = row(sessionId);
  if (session.status === "stopped") throw new HttpError(409, "A stopped session cannot record");
  const parsed = harFile.safeParse(har);
  if (!parsed.success)
    throw new HttpError(400, `Expected a HAR file with at most ${MAX_ENTRIES_PER_SESSION} entries`);
  const hosts = JSON.parse(session.hosts) as string[];
  let added = 0;
  const skipped: string[] = [];
  for (const [index, raw] of parsed.data.log.entries.entries()) {
    const entry = harEntry.safeParse(raw);
    if (!entry.success) {
      skipped.push(`Entry ${index + 1}: malformed`);
      continue;
    }
    const { request, response } = entry.data;
    const problem = checkCaptureTarget(request.url, { allowHttps: session.allowHttps, hosts });
    if (problem) {
      skipped.push(`Entry ${index + 1}: ${problem}`);
      continue;
    }
    const startedAt = Date.parse(entry.data.startedDateTime ?? "");
    try {
      store(
        session,
        {
          method: request.method,
          url: request.url,
          requestHeaders: request.headers.map(({ name, value }) => [name, value] as [string, string]),
          requestBody: { text: "", encoding: "empty", bytes: 0, truncated: false },
          status: response?.status ?? null,
          statusText: response?.statusText ?? "",
          responseHeaders: (response?.headers ?? []).map(
            ({ name, value }) => [name, value] as [string, string],
          ),
          responseBody: { text: "", encoding: "empty", bytes: 0, truncated: false },
          durationMs: entry.data.time === undefined ? null : Math.round(entry.data.time),
          startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
          error: null,
        },
        Buffer.from(request.postData?.text ?? "", "utf8"),
        Buffer.from(response?.content?.text ?? "", "utf8"),
      );
      added++;
    } catch {
      skipped.push(`Entry ${index + 1}: invalid URL`);
    }
  }
  audit({
    action: "capture.session.import",
    entityKind: "captureSession",
    entityId: sessionId,
    entityName: session.name,
    workspaceId: session.workspaceId,
    changes: [],
    meta: { added, skipped: skipped.length },
  });
  return { added, skipped: skipped.slice(0, 50) };
}

// ------------------------------------------------------------------ out

/** Stored entries as a HAR 1.2 file; credentials were removed when they were recorded. */
export function exportHar(sessionId: string, entryIds?: string[]) {
  row(sessionId);
  const rows = getDb()
    .select()
    .from(captureEntries)
    .where(
      entryIds?.length
        ? and(eq(captureEntries.sessionId, sessionId), inArray(captureEntries.id, entryIds))
        : eq(captureEntries.sessionId, sessionId),
    )
    .orderBy(asc(captureEntries.startedAt), asc(captureEntries.id))
    .all();
  return toHar(rows.map(stored));
}

export const createRequestsInput = z
  .object({
    entryIds: z.array(z.string().min(1)).min(1).max(MAX_ENTRIES_PER_SESSION),
    /** Folder to import into; a new top-level folder when omitted. */
    parentId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Turn selected recordings into requests. Replaying them needs credentials added again. */
export function createRequests(sessionId: string, input: z.infer<typeof createRequestsInput>) {
  const session = row(sessionId);
  const ids = [...new Set(input.entryIds)];
  const rows = getDb()
    .select()
    .from(captureEntries)
    .where(and(eq(captureEntries.sessionId, sessionId), inArray(captureEntries.id, ids)))
    .orderBy(asc(captureEntries.startedAt), asc(captureEntries.id))
    .all();
  if (rows.length !== ids.length) throw notFound("Capture entry");
  const usable = rows.filter((entry) => entry.error === null);
  if (!usable.length)
    throw new HttpError(400, "The selected entries failed when recorded and have nothing to import");
  const { root, variables, warnings } = importHar(toHar(usable.map(stored)));
  if (input.name) root.name = input.name;
  const created = repo.importTree(session.workspaceId, root, variables, input.parentId ?? null);
  const now = Date.now();
  getDb()
    .update(captureEntries)
    .set({ importedAt: now })
    .where(
      and(
        eq(captureEntries.sessionId, sessionId),
        inArray(
          captureEntries.id,
          usable.map((entry) => entry.id),
        ),
        isNull(captureEntries.importedAt),
      ),
    )
    .run();
  audit({
    action: "capture.session.to_requests",
    entityKind: "captureSession",
    entityId: sessionId,
    entityName: session.name,
    workspaceId: session.workspaceId,
    changes: [],
    meta: { requests: usable.length, skipped: rows.length - usable.length },
  });
  return { ...created, warnings, skipped: rows.length - usable.length };
}
