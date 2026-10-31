/**
 * Akamai EdgeGrid request authentication (EG1-HMAC-SHA256).
 *
 * Implements the EdgeGrid V1 signing specification:
 * https://techdocs.akamai.com/developer/docs/edgegrid-v1-spec
 *
 * This module is pure TypeScript and only depends on standard node:crypto.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { EdgeGridConfig } from "../types";

export const DEFAULT_MAX_BODY_SIZE = 131072; // 128 KB

/**
 * Format date in EdgeGrid UTC format: yyyyMMddTHH:mm:ss+0000
 */
export function formatEdgeGridTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${m}${d}T${h}:${min}:${s}+0000`;
}

/**
 * Compute the SHA-256 base64 content hash.
 * Only POST bodies are hashed (as in Akamai's SDKs); other methods sign an empty hash.
 * Truncates body up to maxBodySize (default 128KB).
 */
export function makeContentHash(
  body?: Buffer | string,
  method?: string,
  maxBodySize = DEFAULT_MAX_BODY_SIZE,
): string {
  const m = (method ?? "GET").toUpperCase();
  if (m !== "POST" || !body) {
    return "";
  }
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  if (buf.length === 0) {
    return "";
  }
  const effectiveMax = maxBodySize > 0 ? maxBodySize : DEFAULT_MAX_BODY_SIZE;
  const chunk = buf.length > effectiveMax ? buf.subarray(0, effectiveMax) : buf;
  return createHash("sha256").update(chunk).digest("base64");
}

function normalizeHeaderEntries(headers?: [string, string][] | Record<string, string>): [string, string][] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map(([k, v]) => [k.toLowerCase(), v]);
  }
  return Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
}

/**
 * Canonicalize request headers according to EdgeGrid specification.
 * Normalizes header names to lowercase, collapses whitespace in values,
 * keeps the configured headersToSign order, and joins with tab characters.
 */
export function canonicalizeHeaders(
  headers?: [string, string][] | Record<string, string>,
  headersToSign?: string | string[],
): string {
  if (!headersToSign) return "";
  const names = (Array.isArray(headersToSign) ? headersToSign : headersToSign.split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) return "";

  const entries = normalizeHeaderEntries(headers);
  const parts: string[] = [];

  for (const name of names) {
    // Find matching headers
    const matched = entries.filter(([k]) => k === name);
    if (matched.length > 0) {
      // In EdgeGrid, header values have whitespace collapsed and trimmed
      const value = matched.map(([, v]) => v.trim().replace(/\s+/g, " ")).join(",");
      parts.push(`${name}:${value}`);
    }
  }

  return parts.join("\t");
}

/**
 * Compute the temporary signing key derived from the timestamp and client secret.
 */
export function createSigningKey(timestamp: string, clientSecret: string): string {
  return createHmac("sha256", clientSecret).update(timestamp).digest("base64");
}

/**
 * Parse request URL, resolving against baseURL if provided.
 */
export function parseEdgeGridUrl(urlStr: string, baseURL?: string): URL {
  let base = baseURL?.trim();
  if (base && !/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }

  if (base) {
    try {
      return new URL(urlStr, base);
    } catch {
      // fallback to direct parsing
    }
  }

  try {
    return new URL(urlStr);
  } catch {
    try {
      return new URL(`https://${urlStr}`);
    } catch {
      return new URL("https://localhost" + (urlStr.startsWith("/") ? urlStr : `/${urlStr}`));
    }
  }
}

export interface EdgeGridSignOptions {
  method: string;
  url: string;
  headers?: [string, string][] | Record<string, string>;
  body?: Buffer | string;
}

export interface EdgeGridDataToSignParams {
  method: string;
  url: URL;
  authHeaderPrefix: string;
  headers?: [string, string][] | Record<string, string>;
  headersToSign?: string | string[];
  body?: Buffer | string;
  maxBodySize?: number;
}

/**
 * Create the 7 tab-delimited parts that form the data to sign.
 */
export function createDataToSign(params: EdgeGridDataToSignParams): string {
  const method = params.method.toUpperCase();
  const scheme = params.url.protocol.replace(/:$/, "").toLowerCase();
  const host = params.url.host.toLowerCase();
  const pathAndQuery = `${params.url.pathname}${params.url.search}` || "/";
  const canonicalHeaders = canonicalizeHeaders(params.headers, params.headersToSign);
  const contentHash = makeContentHash(params.body, method, params.maxBodySize);

  return [
    method,
    scheme,
    host,
    pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`,
    canonicalHeaders,
    contentHash,
    params.authHeaderPrefix,
  ].join("\t");
}

/**
 * Generate signature given the data to sign and the signing key.
 */
export function createSignature(dataToSign: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(dataToSign).digest("base64");
}

/**
 * Build the full Authorization header value for an Akamai EdgeGrid request.
 */
export function buildEdgeGridAuthHeader(config: EdgeGridConfig, req: EdgeGridSignOptions): string {
  const clientToken = config.clientToken?.trim() ?? "";
  const clientSecret = config.clientSecret?.trim() ?? "";
  const accessToken = config.accessToken?.trim() ?? "";

  const timestamp = config.timestamp || formatEdgeGridTimestamp();
  const nonce = config.nonce || randomUUID();

  const authHeaderPrefix = `EG1-HMAC-SHA256 client_token=${clientToken};access_token=${accessToken};timestamp=${timestamp};nonce=${nonce};`;

  const parsedUrl = parseEdgeGridUrl(req.url, config.baseURL);

  const dataToSign = createDataToSign({
    method: req.method,
    url: parsedUrl,
    authHeaderPrefix,
    headers: req.headers,
    headersToSign: config.headersToSign,
    body: req.body,
    maxBodySize: config.maxBodySize,
  });

  const signingKey = createSigningKey(timestamp, clientSecret);
  const signature = createSignature(dataToSign, signingKey);

  return `${authHeaderPrefix}signature=${signature}`;
}
