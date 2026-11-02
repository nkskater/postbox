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
  type WebhookEvent,
  type WebhookEventType,
} from "@/core/webhooks";
import {
  AdapterError,
  PAGERDUTY_URL,
  URL_IS_CREDENTIAL,
  WEBHOOK_FORMATS,
  checkCustomHeaders,
  renderAdapter,
  type WebhookFormat,
} from "@/core/webhook-adapters";
import { checkVaultDomains, guardedSecrets } from "@/core/vault/guard";
import { SECRET_NAME } from "@/core/vault/crypto";
import { redactSecrets, resolveTemplate } from "@/core/variables/resolver";
import { getPolicy } from "./context";
import { audit } from "./audit";
import { loadVaultForExecution } from "./vault";
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
    /** How the event is formatted: Postbox JSON, or a chat / incident tool. */
    format: z.enum(WEBHOOK_FORMATS).optional(),
    /** Take the signing key from this vault secret instead of generating one. */
    signingKeyRef: z.string().regex(SECRET_NAME).nullish(),
    /** PagerDuty: the vault secret holding the Events API routing key. */
    routingKeyRef: z.string().regex(SECRET_NAME).nullish(),
    /** Extra request headers. Values may be {{vault:name}}; they are never returned. */
    headers: z
      .array(z.object({ name: z.string().min(1).max(100), value: z.string().max(4096) }).strict())
      .max(10)
      .optional(),
    /** Pause after this many deliveries in a row fail for good; 0 never pauses. */
    pauseAfterFailures: z.number().int().min(0).max(1000).optional(),
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
  format: WebhookFormat;
  /** Vault secret names (references, not values). */
  signingKeyRef: string | null;
  routingKeyRef: string | null;
  /** Names only: header values are write-only. */
  headers: { name: string; hasValue: boolean }[];
  pauseAfterFailures: number;
  failureStreak: number;
  pausedAt: number | null;
  pauseReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Pending deliveries and the share that failed, for a quick health read. */
  pending?: number;
}

const VAULT_URL = /^\{\{\s*vault:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*\}\}$/;

const view = (row: WebhookRow): WebhookView => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  // A credential-bearing URL lives in the vault, so this is the reference, never a token.
  url: row.url,
  events: JSON.parse(row.events) as string[],
  enabled: row.enabled,
  format: row.format as WebhookFormat,
  signingKeyRef: row.secretRef || null,
  routingKeyRef: row.routingKeyRef || null,
  headers: (JSON.parse(row.headers) as { name: string; value: string }[]).map((h) => ({
    name: h.name,
    hasValue: h.value !== "",
  })),
  pauseAfterFailures: row.pauseAfterFailures,
  failureStreak: row.failureStreak,
  pausedAt: row.pausedAt,
  pauseReason: row.pauseReason || null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const newSecret = () => SECRET_PREFIX + randomBytes(32).toString("base64url");

/** Refuses an address the instance's host policy blocks, before anything is saved. A vault reference is checked when sent. */
function assertTarget(value: string, format: WebhookFormat) {
  if (VAULT_URL.test(value)) return;
  if (URL_IS_CREDENTIAL.includes(format))
    throw new HttpError(
      400,
      `A ${format} webhook URL is a credential. Store it in the secrets vault and enter {{vault:name}} here.`,
    );
  const problem = checkTargetUrl(value);
  if (problem) throw new HttpError(400, problem);
  const blocked = getPolicy().check(new URL(value).hostname);
  if (blocked)
    throw new HttpError(400, `This server's outbound policy does not allow that address. ${blocked}`);
}

/** The vault secrets webhooks may use: workspace-wide and enabled (no collection scope, no personal secrets). */
function assertVaultNames(workspaceId: string, names: (string | null | undefined)[]) {
  const usable = loadVaultForExecution(workspaceId, null, { unattended: true }).values;
  for (const name of names)
    if (name && !Object.hasOwn(usable, name))
      throw new HttpError(
        400,
        `The vault secret "${name}" is not available to webhooks. It must exist, be enabled and apply to the whole workspace.`,
      );
}

function checkExtras(
  input: {
    headers?: { name: string; value: string }[];
    format?: WebhookFormat;
    routingKeyRef?: string | null;
  },
  format: WebhookFormat,
  routingKeyRef: string | null | undefined,
) {
  const problem = checkCustomHeaders(input.headers ?? []);
  if (problem) throw new HttpError(400, problem);
  if (format === "pagerduty" && !routingKeyRef)
    throw new HttpError(400, "A PagerDuty webhook needs a routing key stored in the vault (routingKeyRef)");
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
  const format = input.format ?? "postbox";
  const url = input.url || (format === "pagerduty" ? PAGERDUTY_URL : "");
  assertTarget(url, format);
  checkExtras(input, format, input.routingKeyRef);
  assertVaultNames(workspaceId, [
    input.signingKeyRef,
    input.routingKeyRef,
    ...vaultNamesIn([url, ...(input.headers ?? []).map((h) => h.value)]),
  ]);
  const db = getDb();
  const existing = db
    .select({ n: count() })
    .from(webhooks)
    .where(eq(webhooks.workspaceId, workspaceId))
    .get();
  if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE)
    throw new HttpError(400, `A workspace can have at most ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks`);
  const now = Date.now();
  const secret = input.signingKeyRef ? "" : newSecret();
  const created: WebhookRow = {
    id: newId(),
    workspaceId,
    name: input.name,
    url,
    secret,
    events: JSON.stringify(input.events),
    enabled: input.enabled ?? true,
    format,
    secretRef: input.signingKeyRef ?? "",
    routingKeyRef: input.routingKeyRef ?? "",
    headers: JSON.stringify(input.headers ?? []),
    pauseAfterFailures: input.pauseAfterFailures ?? 0,
    failureStreak: 0,
    pausedAt: null,
    pauseReason: "",
    createdBy: actorId() ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(webhooks).values(created).run();
  return { ...view(created), secret: input.signingKeyRef ? null : secret };
}

export function updateWebhook(id: string, patch: z.infer<typeof webhookPatch>): WebhookView {
  const current = row(id);
  const format = patch.format ?? (current.format as WebhookFormat);
  const url = patch.url ?? current.url;
  if (patch.url !== undefined && patch.url !== current.url) assertTarget(patch.url, format);
  else if (patch.format !== undefined && !VAULT_URL.test(url) && URL_IS_CREDENTIAL.includes(format))
    assertTarget(url, format);
  const routingKeyRef =
    patch.routingKeyRef === undefined ? current.routingKeyRef : (patch.routingKeyRef ?? "");
  checkExtras(patch, format, routingKeyRef);
  const secretRef = patch.signingKeyRef === undefined ? current.secretRef : (patch.signingKeyRef ?? "");
  const headers = patch.headers ?? (JSON.parse(current.headers) as { name: string; value: string }[]);
  assertVaultNames(current.workspaceId, [
    patch.signingKeyRef,
    patch.routingKeyRef,
    ...vaultNamesIn([url, ...(patch.headers ?? []).map((h) => h.value)]),
  ]);
  const db = getDb();
  // Switching to a vault key drops the stored one; switching back needs a fresh one.
  const secret = secretRef ? "" : current.secret || newSecret();
  const resumed = patch.enabled === true && current.pausedAt !== null;
  db.update(webhooks)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: JSON.stringify(patch.events) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.format !== undefined ? { format } : {}),
      ...(patch.headers !== undefined ? { headers: JSON.stringify(headers) } : {}),
      ...(patch.pauseAfterFailures !== undefined ? { pauseAfterFailures: patch.pauseAfterFailures } : {}),
      ...(resumed ? { pausedAt: null, pauseReason: "", failureStreak: 0 } : {}),
      secret,
      secretRef,
      routingKeyRef,
      updatedAt: Date.now(),
    })
    .where(eq(webhooks.id, id))
    .run();
  return {
    ...view(row(id)),
    ...(secretRef !== current.secretRef && !secretRef ? { secret } : {}),
  } as WebhookView;
}

/** Vault secret names referenced as {{vault:name}} in the given texts. */
function vaultNamesIn(texts: string[]): string[] {
  const names = new Set<string>();
  for (const t of texts)
    for (const m of t.matchAll(/\{\{\s*vault:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*\}\}/g)) names.add(m[1]);
  return [...names];
}

/** Replaces the signing secret; deliveries already queued are signed with the new one. */
export function rotateWebhookSecret(id: string) {
  if (row(id).secretRef)
    throw new HttpError(
      409,
      "This webhook signs with a vault secret. Replace that secret in the vault to rotate it.",
    );
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
  // Vault values are read at send time, so they are never stored with the delivery or visible in any record.
  const vault = loadVaultForExecution(hook.workspaceId, null, { unattended: true });
  const scopes = { vault: vault.values, vaultDomains: vault.domains } as const;
  const resolve = (value: string) =>
    resolveTemplate(value, { globals: {}, collection: {}, environment: {}, data: {}, local: {}, ...scopes });
  const fail = (message: string): { outcome: Outcome; error: string } => ({
    outcome: { kind: "fatal" },
    error: clip(message),
  });

  const target = resolve(hook.url);
  if (target.unresolved.length)
    return fail(
      `The vault secret "${target.unresolved[0].replace(/^vault:/, "")}" for the URL is not available to webhooks`,
    );
  const problem = checkTargetUrl(target.value);
  if (problem) return fail(problem);

  const signingKey = hook.secretRef ? vault.values[hook.secretRef] : hook.secret;
  if (!signingKey)
    return fail(`The vault secret "${hook.secretRef}" for signing is not available to webhooks`);

  const stored = JSON.parse(entry.payload) as WebhookEvent;
  let rendered;
  try {
    const routingKey = hook.routingKeyRef ? vault.values[hook.routingKeyRef] : undefined;
    if (hook.routingKeyRef && !routingKey)
      return fail(
        `The vault secret "${hook.routingKeyRef}" for the routing key is not available to webhooks`,
      );
    rendered = renderAdapter(hook.format as WebhookFormat, stored, entry.payload, { routingKey });
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.message);
    throw error;
  }

  const custom: [string, string][] = [];
  for (const header of JSON.parse(hook.headers) as { name: string; value: string }[]) {
    const value = resolve(header.value);
    if (value.unresolved.length)
      return fail(
        `The vault secret "${value.unresolved[0].replace(/^vault:/, "")}" in the ${header.name} header is not available to webhooks`,
      );
    custom.push([header.name, value.value]);
  }

  const body = rendered.body;
  const headers: [string, string][] = [
    ["Content-Type", rendered.contentType],
    ["User-Agent", "Postbox-Webhooks/1"],
    ["Postbox-Event", entry.eventType],
    ["Postbox-Event-Id", entry.eventId],
    ["Postbox-Delivery", entry.id],
    ["Postbox-Delivery-Attempt", String(entry.attempts + 1)],
    // The signature covers exactly the bytes sent, whatever the format.
    ["Postbox-Signature", signPayload(signingKey, body, now)],
    ...custom,
  ];
  const guarded = guardedSecrets(scopes);
  try {
    const response = await sendRequest(
      {
        method: "POST",
        url: target.value,
        headers,
        body: Buffer.from(body),
        settings: {
          ...DEFAULT_SETTINGS,
          followRedirects: false,
          timeoutMs: DELIVERY_TIMEOUT_MS,
          useCookieJar: false,
        },
      },
      {
        policy: getPolicy(),
        maxBodyBytes: 64 * 1024,
        // A vault secret restricted to certain hosts is not sent anywhere else, even by a webhook.
        guard: guarded.length ? (message) => checkVaultDomains(guarded, message) : undefined,
      },
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
    // A vault secret that would have gone to the wrong host is a configuration error, not worth retrying.
    if (error instanceof RequestError && error.code === "EVAULTDOMAIN") return fail(message);
    // Errors never quote a secret, but redact anyway in case a server echoes one in a message.
    return { outcome: { kind: "retry" }, error: clip(redactSecrets(message, vault.secrets)) };
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
    if (hook.failureStreak)
      db.update(webhooks).set({ failureStreak: 0 }).where(eq(webhooks.id, hook.id)).run();
  } else if (result.outcome.kind === "retry") {
    const delay = nextDelay(attempts, result.outcome.retryAfterMs);
    if (delay === null) {
      finish({
        ...common,
        status: "failed",
        nextAttemptAt: null,
        finishedAt: at,
        lastError: clip(`Gave up after ${MAX_ATTEMPTS} attempts. ${result.error ?? ""}`.trim()),
      });
      recordFailure(hook, result.error);
    } else finish({ ...common, nextAttemptAt: at + delay });
  } else {
    finish({ ...common, status: "failed", nextAttemptAt: null, finishedAt: at });
    recordFailure(hook, result.error);
  }
}

/** Counts a delivery that failed for good, and pauses the webhook once the configured streak is reached. */
function recordFailure(hook: WebhookRow, reason?: string) {
  const db = getDb();
  const current = db.select().from(webhooks).where(eq(webhooks.id, hook.id)).get();
  if (!current) return;
  const streak = current.failureStreak + 1;
  const pause = current.pauseAfterFailures > 0 && streak >= current.pauseAfterFailures && current.enabled;
  const note = `Paused after ${streak} deliveries failed in a row. Last error: ${clip(reason ?? "unknown")}`;
  db.update(webhooks)
    .set({
      failureStreak: streak,
      ...(pause ? { enabled: false, pausedAt: Date.now(), pauseReason: note } : {}),
    })
    .where(eq(webhooks.id, hook.id))
    .run();
  if (pause)
    audit({
      action: "webhook.auto-pause",
      entityKind: "webhook",
      entityId: hook.id,
      entityName: hook.name,
      workspaceId: hook.workspaceId,
      changes: [
        { field: "enabled", before: true, after: false },
        { field: "failureStreak", before: 0, after: streak },
      ],
    });
}
