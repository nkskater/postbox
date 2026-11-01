/**
 * Incoming webhook listener rules that need no database or network: signature verification,
 * header redaction and storage limits. Everything here treats the request as hostile input.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const LISTENER_TOKEN_PREFIX = "hk_";
export const MAX_LISTENERS_PER_WORKSPACE = 20;
/** Largest body a listener accepts; bigger requests get 413 and are not stored. */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENTS_PER_LISTENER = 200;
export const MAX_HEADERS_STORED = 100;
export const MAX_HEADER_VALUE_CHARS = 2000;
export const MAX_PATH_CHARS = 500;
export const MAX_RESPONSE_BODY_CHARS = 4096;
export const DEFAULT_RATE_PER_MINUTE = 120;
export const MAX_RATE_PER_MINUTE = 6000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type VerificationConfig =
  | { type: "none" }
  /** Shared secret sent as-is in a header (for example `X-Gitlab-Token`). */
  | { type: "token"; header: string }
  /** HMAC-SHA256 of the raw body, optionally prefixed (GitHub: `X-Hub-Signature-256`, `sha256=`). */
  | { type: "hmac"; header: string; encoding: "hex" | "base64"; prefix: string }
  /** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (Stripe and Postbox style). */
  | { type: "timestamped"; header: string };

export type SignatureResult = "none" | "valid" | "invalid" | "missing";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newListenerToken = () => LISTENER_TOKEN_PREFIX + randomBytes(24).toString("base64url");
export const isListenerToken = (value: string) => /^hk_[A-Za-z0-9_-]{20,64}$/.test(value);

const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Check a request against the listener's verification settings. `headers` must have lower-case names.
 * The comparison is constant-time and works on the raw bytes, never on a re-encoded string.
 */
export function verifyIncoming(
  config: VerificationConfig,
  secret: string,
  headers: Record<string, string>,
  body: Buffer,
  now: number,
): SignatureResult {
  if (config.type === "none") return "none";
  const given = headers[config.header.toLowerCase()];
  if (!given || !secret) return "missing";
  if (config.type === "token") return equal(Buffer.from(given), Buffer.from(secret)) ? "valid" : "invalid";
  if (config.type === "hmac") {
    if (config.prefix && !given.startsWith(config.prefix)) return "invalid";
    const digest = createHmac("sha256", secret).update(body).digest();
    const offered = given.slice(config.prefix.length).trim();
    const candidate =
      config.encoding === "hex"
        ? /^[0-9a-fA-F]+$/.test(offered)
          ? Buffer.from(offered, "hex")
          : Buffer.alloc(0)
        : Buffer.from(offered, "base64");
    return equal(candidate, digest) ? "valid" : "invalid";
  }
  const parts = new Map<string, string>();
  for (const part of given.split(",")) {
    const index = part.indexOf("=");
    if (index > 0) parts.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const timestamp = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(timestamp) || !/^[0-9a-fA-F]{64}$/.test(v1)) return "invalid";
  if (Math.abs(Math.floor(now / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return "invalid";
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  return equal(Buffer.from(v1, "hex"), digest) ? "valid" : "invalid";
}

const ALWAYS_REDACTED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/** Headers as stored: bounded, with credentials replaced. A shared-token header is a credential too. */
export function storableHeaders(
  headers: Iterable<[string, string]>,
  config: VerificationConfig,
): [string, string][] {
  const out: [string, string][] = [];
  const secretHeader = config.type === "token" ? config.header.toLowerCase() : null;
  for (const [rawName, value] of headers) {
    if (out.length >= MAX_HEADERS_STORED) break;
    const name = rawName.toLowerCase().slice(0, 200);
    const hidden = ALWAYS_REDACTED.has(name) || name === secretHeader;
    out.push([name, hidden ? "[redacted]" : value.slice(0, MAX_HEADER_VALUE_CHARS)]);
  }
  return out;
}

/** The body as text for storage and display: lossless when it is valid UTF-8, base64 otherwise. */
export function storableBody(body: Buffer): { text: string; encoding: "utf8" | "base64" } {
  const text = body.toString("utf8");
  return Buffer.from(text, "utf8").equals(body)
    ? { text, encoding: "utf8" }
    : { text: body.toString("base64"), encoding: "base64" };
}

export const isSafeContentType = (value: string) =>
  /^[a-zA-Z0-9][\w.+-]*\/[a-zA-Z0-9][\w.+-]*(; ?charset=[\w-]+)?$/.test(value) && value.length <= 100;

/** A header name an HTTP client could legitimately send (RFC 9110 token), kept short. */
export const isHeaderName = (value: string) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(value);
