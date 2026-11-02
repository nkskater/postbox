/**
 * Traffic capture rules that need no database or network: what may be stored from a recorded
 * exchange, how credentials are removed before anything is persisted, and how stored entries
 * become a HAR 1.2 archive for the existing importer. Everything captured is hostile input.
 */
import { createHash, randomBytes } from "node:crypto";

export const CAPTURE_TOKEN_PREFIX = "cap_";
export const MAX_SESSIONS_PER_WORKSPACE = 20;
export const MAX_ENTRIES_PER_SESSION = 500;
/** Largest request or response body kept; longer bodies are cut and marked. */
export const MAX_CAPTURE_BODY_BYTES = 256 * 1024;
/** Largest request body the relay will forward. */
export const MAX_RELAY_REQUEST_BYTES = 1024 * 1024;
export const MAX_HEADERS_STORED = 100;
export const MAX_HEADER_VALUE_CHARS = 2000;
export const MAX_URL_CHARS = 4000;
export const MASK = "[redacted]";
export const MAX_HOST_FILTERS = 20;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newCaptureToken = () => CAPTURE_TOKEN_PREFIX + randomBytes(24).toString("base64url");
export const isCaptureToken = (value: string) => /^cap_[A-Za-z0-9_-]{20,64}$/.test(value);

const SENSITIVE_NAME =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|^jwt$|^signature$|^sig$|^key$|^code$|^x-amz-security-token$/i;
/** Cookie names that carry a login even though they do not say "session" or "token". */
const COOKIE_CREDENTIAL =
  /(^|[._-])(sid|ssid|sess\w*|auth\w*|login|csrf|xsrf|remember\w*)([._-]|$)|sess|auth/i;
export const isSensitiveName = (name: string) => SENSITIVE_NAME.test(name);

export interface CapturedBody {
  /** Text, or empty when the body was binary or absent. */
  text: string;
  /** utf8 text, `omitted` for binary content, `empty` for no body. */
  encoding: "utf8" | "omitted" | "empty";
  bytes: number;
  truncated: boolean;
}

export interface CapturedExchange {
  method: string;
  url: string;
  requestHeaders: [string, string][];
  requestBody: CapturedBody;
  status: number | null;
  statusText: string;
  responseHeaders: [string, string][];
  responseBody: CapturedBody;
  durationMs: number | null;
  startedAt: number;
  error: string | null;
}

export interface RedactOptions {
  /** Keep the values of cookies whose names do not look like credentials. Off by default. */
  keepCookies: boolean;
}

/** Collects every credential seen so it can also be removed where an API echoes it back. */
export class SecretSet {
  private values = new Set<string>();
  add(value: string | undefined) {
    const trimmed = value?.trim();
    if (trimmed && trimmed !== MASK && trimmed.length >= 4) this.values.add(trimmed);
  }
  scrub(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join(MASK);
    return out;
  }
  get size() {
    return this.values.size;
  }
}

function rememberAuthorization(value: string, secrets: SecretSet) {
  secrets.add(value);
  secrets.add(value.replace(/^\S+\s+/, ""));
  if (/^Basic\s+/i.test(value)) {
    const decoded = Buffer.from(value.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    secrets.add(decoded);
    const separator = decoded.indexOf(":");
    if (separator >= 0) {
      secrets.add(decoded.slice(0, separator));
      secrets.add(decoded.slice(separator + 1));
    }
  }
}

function redactCookieHeader(name: string, value: string, options: RedactOptions, secrets: SecretSet) {
  const setCookie = /^set-cookie$/i.test(name);
  const parts = setCookie ? [value] : value.split(";");
  const kept = parts.map((part, index) => {
    // Attributes after the first pair of a Set-Cookie line (Path, Expires, ...) are not secret.
    if (setCookie && index > 0) return part;
    const [first, ...attributes] = part.split(";");
    const separator = first.indexOf("=");
    if (separator < 0) return part;
    const cookieName = first.slice(0, separator).trim();
    const cookieValue = first.slice(separator + 1).trim();
    const hide = !options.keepCookies || isSensitiveName(cookieName) || COOKIE_CREDENTIAL.test(cookieName);
    if (hide) secrets.add(cookieValue);
    return [`${cookieName}=${hide ? MASK : cookieValue}`, ...attributes].join(";");
  });
  return setCookie ? kept[0] : kept.join("; ");
}

export function redactHeaders(
  headers: Iterable<[string, string]>,
  options: RedactOptions,
  secrets: SecretSet,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [rawName, rawValue] of headers) {
    if (out.length >= MAX_HEADERS_STORED) break;
    const name = rawName.slice(0, 200);
    const value = rawValue.slice(0, MAX_HEADER_VALUE_CHARS);
    if (/^(set-)?cookie$/i.test(name)) {
      out.push([name, redactCookieHeader(name, value, options, secrets)]);
    } else if (isSensitiveName(name)) {
      if (/^(proxy-)?authorization$/i.test(name)) rememberAuthorization(value, secrets);
      else secrets.add(value);
      out.push([name, MASK]);
    } else out.push([name, value]);
  }
  return out;
}

export function redactUrl(raw: string, secrets: SecretSet): string {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https URLs can be captured");
  if (url.username) secrets.add(decodeURIComponent(url.username));
  if (url.password) secrets.add(decodeURIComponent(url.password));
  url.username = "";
  url.password = "";
  const pairs = [...url.searchParams].map(([key, value]) => {
    if (!isSensitiveName(key)) return [key, value] as const;
    secrets.add(value);
    return [key, MASK] as const;
  });
  url.search = "";
  for (const [key, value] of pairs) url.searchParams.append(key, value);
  url.hash = "";
  return url.toString().slice(0, MAX_URL_CHARS);
}

function redactJson(value: unknown, secrets: SecretSet, depth = 0): unknown {
  if (depth > 50) return MASK;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (isSensitiveName(key)) {
          if (typeof item === "string" || typeof item === "number") secrets.add(String(item));
          return [key, MASK];
        }
        return [key, redactJson(item, secrets, depth + 1)];
      }),
    );
  return value;
}

/** Remove credentials from body text by structure (JSON, forms) and by every secret already seen. */
export function redactText(text: string, contentType: string, secrets: SecretSet): string {
  let out = text;
  if (/json/i.test(contentType)) {
    try {
      out = JSON.stringify(redactJson(JSON.parse(text), secrets), null, 2);
    } catch {
      /* not valid JSON: fall back to value scrubbing below */
    }
  } else if (/x-www-form-urlencoded/i.test(contentType)) {
    const form = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(text)) {
      if (isSensitiveName(key)) secrets.add(value);
      form.append(key, isSensitiveName(key) ? MASK : value);
    }
    out = form.toString();
  }
  return secrets.scrub(out);
}

const TEXTUAL = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|html|yaml|csv/i;

export const headerValue = (headers: [string, string][], name: string) =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";

/** The body as it may be stored: text only, bounded, with credentials removed. */
export function captureBody(
  body: Buffer,
  contentType: string,
  secrets: SecretSet,
  limit = MAX_CAPTURE_BODY_BYTES,
): CapturedBody {
  if (body.length === 0) return { text: "", encoding: "empty", bytes: 0, truncated: false };
  const decoded = body.toString("utf8");
  const text = Buffer.from(decoded, "utf8").equals(body) ? decoded : null;
  if (text === null || (contentType && !TEXTUAL.test(contentType)))
    return { text: "", encoding: "omitted", bytes: body.length, truncated: false };
  const truncated = body.length > limit;
  // Cutting JSON would make structural redaction impossible, so cut after redacting only when
  // it parses; otherwise cut first and scrub by value.
  const source = truncated && !/json/i.test(contentType) ? text.slice(0, limit) : text;
  const redacted = redactText(source, contentType, secrets);
  return {
    text: redacted.length > limit ? redacted.slice(0, limit) : redacted,
    encoding: "utf8",
    bytes: body.length,
    truncated: truncated || redacted.length > limit,
  };
}

/** Hostnames a session may record. Empty allows every host the outbound policy allows. */
export function normalizeHostFilter(values: string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && !/^\[[0-9a-f:]+\]$/.test(host))
      throw new Error(`"${value}" is not a hostname. Use example.com or *.example.com.`);
    out.add(host);
  }
  if (out.size > MAX_HOST_FILTERS) throw new Error(`At most ${MAX_HOST_FILTERS} host filters`);
  return [...out];
}

export function hostAllowed(hostname: string, filters: string[]): boolean {
  if (!filters.length) return true;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return filters.some((filter) =>
    filter.startsWith("*.")
      ? host.endsWith(filter.slice(1)) && host.length > filter.length - 1
      : host === filter,
  );
}

/** Why a target URL cannot be recorded by a session, or null. */
export function checkCaptureTarget(
  raw: string,
  session: { allowHttps: boolean; hosts: string[] },
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The target must be an absolute http or https URL";
  }
  if (!/^https?:$/.test(url.protocol)) return "Only http and https URLs can be captured";
  if (url.protocol === "https:" && !session.allowHttps)
    return "This session has not been authorised to record HTTPS traffic. Turn on HTTPS recording for it first.";
  if (!hostAllowed(url.hostname, session.hosts)) return "That host is not on this session's host list";
  return null;
}

export interface StoredEntry {
  id: string;
  startedAt: number;
  method: string;
  url: string;
  requestHeaders: [string, string][];
  requestBody: CapturedBody;
  status: number | null;
  statusText: string;
  responseHeaders: [string, string][];
  responseBody: CapturedBody;
  durationMs: number | null;
}

const harPairs = (headers: [string, string][]) => headers.map(([name, value]) => ({ name, value }));

/** Stored entries as HAR 1.2, ready for the HAR importer (which also redacts and warns). */
export function toHar(entries: StoredEntry[]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Postbox capture", version: "1" },
      entries: entries.map((entry) => {
        const contentType = headerValue(entry.requestHeaders, "content-type") || "text/plain";
        const responseType = headerValue(entry.responseHeaders, "content-type") || "text/plain";
        const url = new URL(entry.url);
        return {
          startedDateTime: new Date(entry.startedAt).toISOString(),
          time: entry.durationMs ?? 0,
          request: {
            method: entry.method,
            url: entry.url,
            headers: harPairs(entry.requestHeaders),
            queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
            cookies: [],
            ...(entry.requestBody.encoding === "utf8"
              ? { postData: { mimeType: contentType, text: entry.requestBody.text } }
              : {}),
          },
          ...(entry.status === null
            ? {}
            : {
                response: {
                  status: entry.status,
                  statusText: entry.statusText,
                  headers: harPairs(entry.responseHeaders),
                  cookies: [],
                  ...(entry.responseBody.encoding === "utf8"
                    ? { content: { mimeType: responseType, text: entry.responseBody.text } }
                    : {}),
                },
              }),
        };
      }),
    },
  };
}

/** Headers an upstream request must not carry over from the recording client. */
const HOP_BY_HOP =
  /^(host|connection|keep-alive|proxy-connection|transfer-encoding|te|trailer|upgrade|content-length)$/i;
export const forwardableHeaders = (headers: Iterable<[string, string]>): [string, string][] =>
  [...headers].filter(([name]) => !HOP_BY_HOP.test(name));

/**
 * The absolute URL a relay request names. The path after the token is the URL itself
 * (`/capture/<token>/https://host/a?b=1`) or a percent-encoded URL. Some clients and proxies
 * collapse `//` to `/`, so `https:/host` is repaired. Returns null when it is not a URL.
 */
export function parseRelayTarget(rest: string, search: string): string | null {
  let target = rest.replace(/^\/+/, "");
  if (/^https?%3a/i.test(target)) {
    try {
      target = decodeURIComponent(target);
    } catch {
      return null;
    }
  }
  target = target.replace(/^(https?):\/(?!\/)/i, "$1://");
  if (!/^https?:\/\/[^/]/i.test(target)) return null;
  return target + search;
}
