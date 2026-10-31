/**
 * AWS Signature Version 4 request signing (header or query-string form).
 *
 * Canonicalization follows the AWS SDKs: the path as sent on the wire is
 * normalized and encoded a second time except for S3, query parameters are
 * decoded and re-encoded with RFC 3986 rules, and every header is signed except
 * the ones AWS documents as safe to change in transit.
 */
import { createHash, createHmac } from "node:crypto";
import type { AwsSigV4Config } from "../types";

const ALGORITHM = "AWS4-HMAC-SHA256";
/** Headers that proxies or the HTTP stack may change; AWS SDKs never sign them. */
const UNSIGNED_HEADERS = new Set([
  "authorization",
  "connection",
  "expect",
  "presigned-expires",
  "range",
  "user-agent",
  "x-amzn-trace-id",
]);
/** Headers and query parameters this signer writes, removed before (re-)signing. */
const SIGNING_HEADERS = ["authorization", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"];
const SIGNING_PARAMS = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Security-Token",
  "X-Amz-Signature",
];
export const DEFAULT_PRESIGN_EXPIRES = 3600;
const MAX_PRESIGN_EXPIRES = 604800;

export interface AwsSignableRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Buffer | string;
}

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding: everything except unreserved characters is percent-encoded. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 20150830T123600Z */
export function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function canonicalPath(pathname: string, service: string): string {
  if (!pathname || pathname === "/") return "/";
  const s3 = service.toLowerCase() === "s3";
  if (s3) {
    // S3 signs the path exactly as sent, encoded once, without dot-segment normalization.
    return pathname
      .split("/")
      .map((seg) => encodeRfc3986(safeDecode(seg)))
      .join("/");
  }
  const segments: string[] = [];
  for (const seg of pathname.replace(/\/{2,}/g, "/").split("/")) {
    if (seg === "..") segments.pop();
    else if (seg !== ".") segments.push(encodeRfc3986(seg));
  }
  const path = segments.join("/");
  return path.startsWith("/") ? path : `/${path}`;
}

/** Split a raw query string without treating "+" as a space (AWS does not). */
function queryPairs(search: string): [string, string][] {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return [];
  return raw
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1
        ? [safeDecode(part), ""]
        : [safeDecode(part.slice(0, eq)), safeDecode(part.slice(eq + 1))];
    });
}

export function canonicalQuery(pairs: [string, string][]): string {
  return pairs
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Lowercased, value-normalized headers to sign, sorted by name (duplicates joined with ","). */
function signableHeaders(headers: [string, string][], host: string): [string, string][] {
  const merged = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase().trim();
    if (UNSIGNED_HEADERS.has(key)) continue;
    const list = merged.get(key) ?? [];
    list.push(value.trim().replace(/\s+/g, " "));
    merged.set(key, list);
  }
  if (!merged.has("host")) merged.set("host", [host]);
  return [...merged.entries()]
    .map(([k, v]) => [k, v.join(",")] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

export function signingKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  return hmac(hmac(hmac(kDate, region), service), "aws4_request");
}

export interface AwsSignatureParts {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  credential: string;
  amzDate: string;
}

function requireConfig(config: AwsSigV4Config) {
  const accessKey = config.accessKey?.trim();
  const secretKey = config.secretKey?.trim();
  const region = config.region?.trim() || "us-east-1";
  const service = config.service?.trim();
  if (!accessKey || !secretKey) throw new Error("AWS Signature requires an access key and a secret key");
  if (!service) throw new Error("AWS Signature requires a service name (for example execute-api or s3)");
  return { accessKey, secretKey, region, service, sessionToken: config.sessionToken?.trim() || undefined };
}

/** Remove anything a previous signing pass added, so a request can be signed again. */
export function stripAwsSignature(req: AwsSignableRequest): AwsSignableRequest {
  let url = req.url;
  try {
    const u = new URL(req.url);
    const kept = queryPairs(u.search).filter(([k]) => !SIGNING_PARAMS.includes(k));
    u.search = kept.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
    url = u.toString();
  } catch {
    // Unparseable URLs are rejected by signAwsRequest.
  }
  return { ...req, url, headers: req.headers.filter(([k]) => !SIGNING_HEADERS.includes(k.toLowerCase())) };
}

/**
 * Sign a request. Returns the request with Authorization (header mode) or
 * X-Amz-* query parameters (query mode) added. The input is not modified.
 */
export function signAwsRequest(
  input: AwsSignableRequest,
  config: AwsSigV4Config,
  now: Date = new Date(),
): AwsSignableRequest & { parts: AwsSignatureParts } {
  const { accessKey, secretKey, region, service, sessionToken } = requireConfig(config);
  const req = stripAwsSignature(input);
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new Error(`Invalid URL for AWS signing: ${req.url}`);
  }
  const amzDate = config.timestamp?.trim() || formatAmzDate(now);
  if (!/^\d{8}T\d{6}Z$/.test(amzDate))
    throw new Error("AWS Signature timestamp must look like 20150830T123600Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKey}/${scope}`;
  const s3 = service.toLowerCase() === "s3";
  const query = config.addTo === "query";
  const method = req.method.toUpperCase();

  let headers = req.headers.slice();
  let pairs = queryPairs(url.search);
  let payloadHash = query && s3 ? "UNSIGNED-PAYLOAD" : sha256Hex(req.body ?? "");

  if (query) {
    const expires = Math.min(
      Math.max(1, Math.floor(config.expiresSeconds ?? DEFAULT_PRESIGN_EXPIRES)),
      MAX_PRESIGN_EXPIRES,
    );
    pairs.push(["X-Amz-Algorithm", ALGORITHM], ["X-Amz-Credential", credential], ["X-Amz-Date", amzDate]);
    pairs.push(["X-Amz-Expires", String(expires)]);
    if (sessionToken) pairs.push(["X-Amz-Security-Token", sessionToken]);
  } else {
    headers.push(["X-Amz-Date", amzDate]);
    if (sessionToken) headers.push(["X-Amz-Security-Token", sessionToken]);
    if (s3) headers.push(["X-Amz-Content-Sha256", payloadHash]);
  }
  // A caller-provided content hash (e.g. UNSIGNED-PAYLOAD for streaming S3 uploads) wins.
  const explicitHash = headers.find(([k]) => k.toLowerCase() === "x-amz-content-sha256")?.[1];
  if (explicitHash) payloadHash = explicitHash.trim();

  const signed = signableHeaders(headers, url.host);
  const signedHeaders = signed.map(([k]) => k).join(";");
  if (query) pairs.push(["X-Amz-SignedHeaders", signedHeaders]);

  const canonicalRequest = [
    method,
    canonicalPath(url.pathname, service),
    canonicalQuery(pairs),
    signed.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(secretKey, dateStamp, region, service))
    .update(stringToSign)
    .digest("hex");

  if (query) {
    pairs = [...pairs, ["X-Amz-Signature", signature]];
    url.search = pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
  } else {
    headers = [
      ...headers,
      [
        "Authorization",
        `${ALGORITHM} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ],
    ];
  }
  return {
    ...req,
    url: url.toString(),
    headers,
    parts: { canonicalRequest, stringToSign, signature, signedHeaders, credential, amzDate },
  };
}
