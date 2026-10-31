/**
 * Hawk HTTP request authentication (RFC draft-hammer-hawk).
 * Computes partial cryptographic verification headers using HMAC digests.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { HawkAlgorithm, HawkConfig } from "../types";

export interface HawkNormalizedOptions {
  ts: string;
  nonce: string;
  method: string;
  resource: string;
  host: string;
  port: string;
  hash?: string;
  ext?: string;
  app?: string;
  dlg?: string;
}

/**
 * Compute the cryptographic hash of a request payload according to the Hawk protocol.
 */
export function calculatePayloadHash(
  body: Buffer | string | undefined | null,
  algorithm: HawkAlgorithm = "sha256",
  contentType?: string,
): string {
  if (algorithm !== "sha256" && algorithm !== "sha1") {
    throw new Error(`Unsupported Hawk algorithm: ${algorithm}`);
  }
  const normalizedContentType = contentType ? contentType.split(";")[0].trim().toLowerCase() : "";
  const hash = createHash(algorithm);
  hash.update("hawk.1.payload\n");
  hash.update(normalizedContentType + "\n");
  if (body) {
    hash.update(body);
  }
  hash.update("\n");
  return hash.digest("base64");
}

/** Hawk escapes backslashes and newlines in extension data before normalizing. */
function escapeNormalizedExt(ext: string | undefined): string {
  return (ext ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Escape a quoted header attribute; control characters cannot be carried at all. */
function headerAttribute(name: string, value: string, escape: boolean): string {
  if (/[^\x20-\x7E\x80-\xFF]/.test(value)) {
    throw new Error(`Hawk ${name} contains characters that cannot be sent in a header`);
  }
  if (!escape && /["\\]/.test(value)) {
    throw new Error(`Hawk ${name} cannot contain quotes or backslashes`);
  }
  return `${name}="${escape ? value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : value}"`;
}

/**
 * Generate the normalized request string for Hawk version 1 header verification.
 */
export function generateHawkNormalizedString(options: HawkNormalizedOptions): string {
  let normalized =
    "hawk.1.header\n" +
    `${options.ts}\n` +
    `${options.nonce}\n` +
    `${options.method.toUpperCase()}\n` +
    `${options.resource}\n` +
    `${options.host.toLowerCase()}\n` +
    `${options.port}\n` +
    `${options.hash || ""}\n` +
    `${escapeNormalizedExt(options.ext)}\n`;

  if (options.app) {
    normalized += `${options.app}\n${options.dlg || ""}\n`;
  }

  return normalized;
}

/**
 * Calculate the HMAC MAC digest over a normalized Hawk string.
 */
export function calculateHawkMac(
  normalized: string,
  key: string,
  algorithm: HawkAlgorithm = "sha256",
): string {
  if (algorithm !== "sha256" && algorithm !== "sha1") {
    throw new Error(`Unsupported Hawk algorithm: ${algorithm}`);
  }
  if (!key) {
    throw new Error("Hawk authentication key is required to calculate MAC");
  }
  return createHmac(algorithm, key).update(normalized).digest("base64");
}

/**
 * Build the full Authorization header value for a Hawk-authenticated request.
 */
export function buildHawkHeader(
  req: {
    method: string;
    url: string;
    headers: [string, string][];
    body?: Buffer | string;
  },
  config: HawkConfig,
): string {
  if (!config.authId || !config.authKey) {
    throw new Error("Hawk authentication requires both Auth ID and Auth Key");
  }
  const algorithm = config.algorithm || "sha256";
  if (algorithm !== "sha256" && algorithm !== "sha1") {
    throw new Error(`Unsupported Hawk algorithm: ${algorithm}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    throw new Error(`Invalid URL for Hawk signing: ${req.url}`);
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const resource = (parsed.pathname || "/") + parsed.search;

  const rawTs = config.timestamp ?? (config as unknown as { ts?: string }).ts;
  const ts = rawTs?.trim() || Math.floor(Date.now() / 1000).toString();
  const nonce = config.nonce?.trim() || randomBytes(6).toString("hex");

  let hash: string | undefined;
  if (config.includePayloadHash) {
    const contentTypeHeader = req.headers.find(([k]) => k.toLowerCase() === "content-type");
    const contentType = contentTypeHeader ? contentTypeHeader[1] : "";
    hash = calculatePayloadHash(req.body, algorithm, contentType);
  }

  const normalized = generateHawkNormalizedString({
    ts,
    nonce,
    method: req.method,
    resource,
    host,
    port,
    hash,
    ext: config.ext,
    app: config.app,
    dlg: config.dlg,
  });

  const mac = calculateHawkMac(normalized, config.authKey, algorithm);

  const parts: string[] = [
    headerAttribute("id", config.authId, false),
    headerAttribute("ts", ts, false),
    headerAttribute("nonce", nonce, false),
  ];
  if (hash) parts.push(`hash="${hash}"`);
  if (config.ext) parts.push(headerAttribute("ext", config.ext, true));
  if (config.app) parts.push(headerAttribute("app", config.app, false));
  if (config.dlg) parts.push(headerAttribute("dlg", config.dlg, false));
  if (config.user) parts.push(headerAttribute("user", config.user, false));
  parts.push(`mac="${mac}"`);

  return `Hawk ${parts.join(", ")}`;
}
