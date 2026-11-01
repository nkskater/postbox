/**
 * Outbound webhooks: configuration, a durable outbox, and a delivery worker.
 *
 * Events are written to `webhook_deliveries` before anything is sent, so a restart never
 * loses one. Each delivery keeps one id across retries and is sent through the same
 * host-policy-checked HTTP engine as requests (including the DNS check). A delivery is at
 * least once: receivers deduplicate on `Postbox-Event-Id` / `Postbox-Delivery`.
 */
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import { sendRequest, RequestError } from "@/core/http/engine";
import { HostPolicyError } from "@/core/http/policy";
import { DEFAULT_SETTINGS } from "@/core/types";
import {
  DELIVERY_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_PAYLOAD_BYTES,
  SECRET_PREFIX,
  SUBSCRIBABLE_EVENTS,
  buildEvent,
  checkTargetUrl,
  classifyStatus,
  nextDelay,
  signPayload,
  type Outcome,
  type WebhookEventType,
} from "@/core/webhooks";
import { getPolicy } from "./context";
import { getDb, schema } from "./db";
import type { WebhookDeliveryRow, WebhookRow } from "./db/schema";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { HttpError, notFound } from "./errors";

const { webhooks, webhookDeliveries, webhookAttempts } = schema;

export const MAX_WEBHOOKS_PER_WORKSPACE = 20;
export const MAX_PENDING_PER_WEBHOOK = 1000;
const CLAIM_MS = 60_000;
const CONCURRENCY = 4;
const MAX_ERROR_CHARS = 500;

// ------------------------------------------------------------------ configuration

export const webhookInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    url: z.string().trim().max(2000),
    events: z
      .array(z.string())
      .min(1, "Choose at least one event")
      .max(20)
      .refine((list) => list.every((type) => SUBSCRIBABLE_EVENTS.includes(type)), "Unknown event type")
      .transform((list) => [...new Set(list)]),
    enabled: z.boolean().optional(),
  })
  .strict();
export const webhookPatch = webhookInput.partial();

export interface WebhookView {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Pending deliveries and the share that failed, for a quick health read. */
  pending?: number;
}

const view = (row: WebhookRow): WebhookView => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  url: row.url,
  events: JSON.parse(row.events) as string[],
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const newSecret = () => SECRET_PREFIX + randomBytes(32).toString("base64url");

/** Refuses an address the instance's host policy blocks, before anything is saved. */
function assertTarget(value: string) {
  const problem = checkTargetUrl(value);
  if (problem) throw new HttpError(400, problem);
  const blocked = getPolicy().check(new URL(value).hostname);
  if (blocked)
    throw new HttpError(400, `This server's outbound policy does not allow that address. ${blocked}`);
}

function row(id: string): WebhookRow {
  const found = getDb().select().from(webhooks).where(eq(webhooks.id, id)).get();
  if (!found) throw notFound("Webhook");
  return found;
}

export function listWebhooks(workspaceId: string): WebhookView[] {
  const db = getDb();
  const pending = new Map(
    db
      .select({ id: webhookDeliveries.webhookId, n: count() })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.workspaceId, workspaceId), eq(webhookDeliveries.status, "pending")))
      .groupBy(webhookDeliveries.webhookId)
      .all()
      .map((entry) => [entry.id, entry.n]),
  );
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.workspaceId, workspaceId))
    .orderBy(asc(webhooks.createdAt))
    .all()
    .map((entry) => ({ ...view(entry), pending: pending.get(entry.id) ?? 0 }));
}

export function getWebhook(id: string): WebhookView {
  return view(row(id));
}

/** The only response that includes the signing secret. */
export function createWebhook(workspaceId: string, input: z.infer<typeof webhookInput>) {
  assertTarget(input.url);
  const db = getDb();
  const existing = db
    .select({ n: count() })
    .from(webhooks)
    .where(eq(webhooks.workspaceId, workspaceId))
    .get();
  if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE)
    throw new HttpError(400, `A workspace can have at most ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks`);
  const now = Date.now();
  const secret = newSecret();
  const created: WebhookRow = {
    id: newId(),
    workspaceId,
    name: input.name,
    url: input.url,
    secret,
    events: JSON.stringify(input.events),
    enabled: input.enabled ?? true,
    createdBy: actorId() ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(webhooks).values(created).run();
  return { ...view(created), secret };
}

export function updateWebhook(id: string, patch: z.infer<typeof webhookPatch>): WebhookView {
  const current = row(id);
  if (patch.url !== undefined && patch.url !== current.url) assertTarget(patch.url);
  getDb()
    .update(webhooks)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: JSON.stringify(patch.events) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(webhooks.id, id))
    .run();
  return view(row(id));
}

/** Replaces the signing secret; deliveries already queued are signed with the new one. */
export function rotateWebhookSecret(id: string) {
  row(id);
  const secret = newSecret();
  getDb().update(webhooks).set({ secret, updatedAt: Date.now() }).where(eq(webhooks.id, id)).run();
  return { ...view(row(id)), secret };
}

export function deleteWebhook(id: string) {
  getDb().delete(webhooks).where(eq(webhooks.id, id)).run();
}

// ------------------------------------------------------------------ outbox

function enqueue(
  hook: WebhookRow,
  event: { id: string; type: string },
  payload: string,
  now: number,
  replayOf?: string,
) {
  const db = getDb();
  const queued = db
    .select({ n: count() })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.webhookId, hook.id), eq(webhookDeliveries.status, "pending")))
    .get();
  const full = (queued?.n ?? 0) >= MAX_PENDING_PER_WEBHOOK;
  const delivery: WebhookDeliveryRow = {
    id: newId(),
    webhookId: hook.id,
    workspaceId: hook.workspaceId,
    eventId: event.id,
    eventType: event.type,
    payload,
    status: full ? "failed" : "pending",
    attempts: 0,
    nextAttemptAt: full ? null : now,
    lockedUntil: null,
    lastStatus: null,
    lastError: full ? "Not queued: too many deliveries are already waiting for this webhook" : null,
    replayOf: replayOf ?? null,
    createdAt: now,
    finishedAt: full ? now : null,
  };
  db.insert(webhookDeliveries).values(delivery).run();
  return delivery;
}

/**
 * Queue an event for every enabled webhook in the workspace that subscribed to it.
 * Never throws: a broken integration must not break the action that produced the event.
 */
export function emitEvent(
  workspaceId: string,
  type: Exclude<WebhookEventType, "webhook.test">,
  data: unknown,
  at = Date.now(),
): number {
  try {
    const hooks = getDb()
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.enabled, true)))
      .all()
      .filter((hook) => (JSON.parse(hook.events) as string[]).includes(type));
    if (!hooks.length) return 0;
    const event = buildEvent(newId(), type, workspaceId, data, at);
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return 0;
    for (const hook of hooks) enqueue(hook, event, payload, at);
    kick();
    return hooks.length;
  } catch (error) {
    console.error("postbox: webhook event was not queued:", (error as Error).message);
    return 0;
  }
}

/** A test event goes to one webhook whether or not it subscribed to anything. */
export function sendTestEvent(id: string, at = Date.now()) {
  const hook = row(id);
  const event = buildEvent(
    newId(),
    "webhook.test",
    hook.workspaceId,
    { message: "Test event from Postbox" },
    at,
  );
  const delivery = enqueue(hook, event, JSON.stringify(event), at);
  kick();
  return deliveryView(delivery);
}

/** Queue the same event again as a new delivery (same event id, fresh signature and attempts). */
export function replayDelivery(webhookId: string, deliveryId: string, at = Date.now()) {
  const hook = row(webhookId);
  const original = getDb()
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)))
    .get();
  if (!original) throw notFound("Delivery");
  if (original.status === "pending") throw new HttpError(409, "That delivery is still waiting to be sent");
  const copy = enqueue(
    hook,
    { id: original.eventId, type: original.eventType },
    original.payload,
    at,
    original.id,
  );
  kick();
  return deliveryView(copy);
}

// ------------------------------------------------------------------ delivery log

export interface DeliveryView {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const deliveryView = (entry: WebhookDeliveryRow): DeliveryView => ({
  id: entry.id,
  webhookId: entry.webhookId,
  eventId: entry.eventId,
  eventType: entry.eventType,
  status: entry.status,
  attempts: entry.attempts,
  nextAttemptAt: entry.nextAttemptAt,
  lastStatus: entry.lastStatus,
  lastError: entry.lastError,
  replayOf: entry.replayOf,
  createdAt: entry.createdAt,
  finishedAt: entry.finishedAt,
});

export function listDeliveries(webhookId: string, options: { status?: string; limit?: number } = {}) {
  row(webhookId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return getDb()
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, webhookId),
        options.status ? eq(webhookDeliveries.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit)
    .all()
    .map(deliveryView);
}

/** One delivery with its attempts and the exact payload that was (or will be) sent. */
export function getDelivery(webhookId: string, deliveryId: string) {
  row(webhookId);
  const db = getDb();
  const entry = db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)))
    .get();
  if (!entry) throw notFound("Delivery");
  const attempts = db
    .select()
    .from(webhookAttempts)
    .where(eq(webhookAttempts.deliveryId, deliveryId))
    .orderBy(asc(webhookAttempts.at))
    .all();
  return { ...deliveryView(entry), payload: JSON.parse(entry.payload) as unknown, attemptLog: attempts };
}

/** Drops finished deliveries (and their attempts) older than the retention period. */
export function pruneWebhooks(days: number, at = Date.now()): number {
  if (!days || days <= 0) return 0;
  const result = getDb()
    .delete(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.status, ["delivered", "failed"]),
        lt(webhookDeliveries.createdAt, at - days * 86_400_000),
      ),
    )
    .run();
  return result.changes;
}

// ------------------------------------------------------------------ worker

interface WorkerState {
  timer: ReturnType<typeof setTimeout> | null;
  running: number;
  manual: boolean;
}
const globals = globalThis as typeof globalThis & { __postboxWebhooks?: WorkerState };
const worker = (globals.__postboxWebhooks ??= { timer: null, running: 0, manual: false });

/** Tests drive the outbox by hand with `processDue`; the timer is then never started. */
export function setWebhookWorkerManual(manual: boolean) {
  worker.manual = manual;
  if (manual && worker.timer) clearTimeout(worker.timer);
  if (manual) worker.timer = null;
}

function wake(delayMs: number) {
  if (worker.manual) return;
  if (worker.timer) clearTimeout(worker.timer);
  worker.timer = setTimeout(
    () => {
      worker.timer = null;
      // A pass must never throw into the event loop (for example while the database is closing).
      processDue()
        .then(reschedule)
        .catch((error: unknown) => console.error("postbox: webhook worker:", (error as Error).message));
    },
    Math.max(0, delayMs),
  );
  worker.timer.unref?.();
}
const kick = () => wake(0);

function reschedule() {
  if (worker.manual) return;
  const next = getDb()
    .select({ at: webhookDeliveries.nextAttemptAt })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.status, "pending"))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(1)
    .get();
  if (next?.at != null) wake(Math.min(Math.max(next.at - Date.now(), 1000), 60_000));
}

/** Resume the outbox after a restart. Called once at startup. */
export function startWebhookWorker() {
  try {
    wake(2000);
  } catch {
    // The database may not be ready yet; the first emitted event starts the worker.
  }
}

/** Atomically takes due deliveries so two workers (or a retry timer) never send the same one twice. */
function claim(now: number, limit: number): WebhookDeliveryRow[] {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const due = tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.status, "pending"),
            lte(webhookDeliveries.nextAttemptAt, now),
            or(isNull(webhookDeliveries.lockedUntil), lt(webhookDeliveries.lockedUntil, now)),
          ),
        )
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(limit)
        .all();
      for (const entry of due)
        tx.update(webhookDeliveries)
          .set({ lockedUntil: now + CLAIM_MS })
          .where(eq(webhookDeliveries.id, entry.id))
          .run();
      return due;
    },
    { behavior: "immediate" },
  );
}

/** One pass over everything due. Returns how many deliveries were attempted. */
export async function processDue(now = Date.now()): Promise<number> {
  let attempted = 0;
  for (;;) {
    const room = CONCURRENCY - worker.running;
    if (room <= 0) break;
    const batch = claim(now, room);
    if (!batch.length) break;
    worker.running += batch.length;
    attempted += batch.length;
    await Promise.all(
      batch.map((entry) =>
        deliver(entry, now).finally(() => {
          worker.running -= 1;
        }),
      ),
    );
  }
  return attempted;
}

const clip = (value: string) =>
  value.length > MAX_ERROR_CHARS ? value.slice(0, MAX_ERROR_CHARS) + "…" : value;

async function attemptSend(
  hook: WebhookRow,
  entry: WebhookDeliveryRow,
  now: number,
): Promise<{ outcome: Outcome; status?: number; error?: string }> {
  // Targets are checked again on every attempt: the policy or the DNS answer may have changed.
  const problem = checkTargetUrl(hook.url);
  if (problem) return { outcome: { kind: "fatal" }, error: problem };
  const body = entry.payload;
  const headers: [string, string][] = [
    ["Content-Type", "application/json"],
    ["User-Agent", "Postbox-Webhooks/1"],
    ["Postbox-Event", entry.eventType],
    ["Postbox-Event-Id", entry.eventId],
    ["Postbox-Delivery", entry.id],
    ["Postbox-Delivery-Attempt", String(entry.attempts + 1)],
    ["Postbox-Signature", signPayload(hook.secret, body, now)],
  ];
  try {
    const response = await sendRequest(
      {
        method: "POST",
        url: hook.url,
        headers,
        body: Buffer.from(body),
        settings: {
          ...DEFAULT_SETTINGS,
          followRedirects: false,
          timeoutMs: DELIVERY_TIMEOUT_MS,
          useCookieJar: false,
        },
      },
      { policy: getPolicy(), maxBodyBytes: 64 * 1024 },
    );
    const retryAfter = response.headers.find(([name]) => name.toLowerCase() === "retry-after")?.[1];
    const outcome = classifyStatus(response.status, retryAfter, now);
    return {
      outcome,
      status: response.status,
      error:
        outcome.kind === "delivered"
          ? undefined
          : response.status >= 300 && response.status < 400
            ? `Redirects are not followed (HTTP ${response.status})`
            : `HTTP ${response.status}`,
    };
  } catch (error) {
    if (error instanceof HostPolicyError)
      return { outcome: { kind: "fatal" }, error: clip(`Blocked by outbound policy: ${error.message}`) };
    const message = error instanceof RequestError ? error.message : (error as Error).message;
    return { outcome: { kind: "retry" }, error: clip(message) };
  }
}

async function deliver(entry: WebhookDeliveryRow, now: number): Promise<void> {
  const db = getDb();
  const hook = db.select().from(webhooks).where(eq(webhooks.id, entry.webhookId)).get();
  const finish = (set: Partial<WebhookDeliveryRow>) =>
    db
      .update(webhookDeliveries)
      .set({ lockedUntil: null, ...set })
      .where(eq(webhookDeliveries.id, entry.id))
      .run();
  // Authorization is the webhook's existence and its enabled flag at send time.
  if (!hook || !hook.enabled) {
    finish({
      status: "failed",
      nextAttemptAt: null,
      finishedAt: Date.now(),
      lastError: hook ? "The webhook was disabled before this was sent" : "The webhook was deleted",
    });
    return;
  }
  const started = performance.now();
  const result = await attemptSend(hook, entry, now);
  const attempts = entry.attempts + 1;
  const at = Date.now();
  db.insert(webhookAttempts)
    .values({
      id: newId(),
      deliveryId: entry.id,
      at,
      status: result.status ?? null,
      error: result.error ?? null,
      durationMs: Math.round(performance.now() - started),
    })
    .run();
  const common = { attempts, lastStatus: result.status ?? null, lastError: result.error ?? null };
  if (result.outcome.kind === "delivered") {
    finish({ ...common, status: "delivered", nextAttemptAt: null, finishedAt: at, lastError: null });
  } else if (result.outcome.kind === "retry") {
    const delay = nextDelay(attempts, result.outcome.retryAfterMs);
    if (delay === null)
      finish({
        ...common,
        status: "failed",
        nextAttemptAt: null,
        finishedAt: at,
        lastError: clip(`Gave up after ${MAX_ATTEMPTS} attempts. ${result.error ?? ""}`.trim()),
      });
    else finish({ ...common, nextAttemptAt: at + delay });
  } else finish({ ...common, status: "failed", nextAttemptAt: null, finishedAt: at });
}
