/**
 * Outbound webhook rules that need no database or network: event names,
 * payload envelopes, signatures, retry schedule and result classification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export { SUBSCRIBABLE_EVENTS, WEBHOOK_EVENTS, type WebhookEventType } from "./webhook-events";
import type { WebhookEventType } from "./webhook-events";

export const MAX_ATTEMPTS = 6;
/** Delay before retry n (1-based): 10 s, 1 min, 5 min, 30 min, 2 h. */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000] as const;
export const MAX_RETRY_AFTER_MS = 3_600_000;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface WebhookEvent<T = unknown> {
  /** Stable across attempts and replays: receivers deduplicate on it. */
  id: string;
  type: WebhookEventType;
  createdAt: string;
  workspaceId: string;
  data: T;
}

export function buildEvent<T>(
  id: string,
  type: WebhookEventType,
  workspaceId: string,
  data: T,
  at: number,
): WebhookEvent<T> {
  return { id, type, createdAt: new Date(at).toISOString(), workspaceId, data };
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signPayload(secret: string, body: string, at: number): string {
  const timestamp = Math.floor(at / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/** What a receiver runs. Constant-time compare, with a replay window on the timestamp. */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  now: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  ) as Record<string, string>;
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Webhook secrets look like `whsec_` plus 32 random bytes in base64url. */
export const SECRET_PREFIX = "whsec_";

export type Outcome =
  /** 2xx. */
  | { kind: "delivered" }
  /** Worth another attempt: network error, timeout, 408, 425, 429 or 5xx. */
  | { kind: "retry"; retryAfterMs?: number }
  /** Retrying cannot help: other 4xx, redirects, blocked or invalid target. */
  | { kind: "fatal" };

export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_MS);
}

export function classifyStatus(status: number, retryAfter: string | undefined, now: number): Outcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if ([408, 425, 429].includes(status) || status >= 500)
    return { kind: "retry", retryAfterMs: parseRetryAfter(retryAfter, now) };
  return { kind: "fatal" };
}

/**
 * Milliseconds until the next attempt after `attempts` have been made, or null when
 * the budget is spent. A Retry-After from the receiver can lengthen, never shorten, the wait.
 */
export function nextDelay(attempts: number, retryAfterMs?: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];
  return Math.max(base, retryAfterMs ?? 0);
}

/** Shape checks that do not need DNS: the host policy and resolver check the rest at delivery. */
export function checkTargetUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL such as https://example.com/hooks/postbox";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "The URL must start with http:// or https://";
  if (url.username || url.password) return "Do not put credentials in the URL; the payload is signed instead";
  if (url.hash) return "Remove the #fragment from the URL";
  return null;
}
