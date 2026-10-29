/**
 * HTTP Digest access authentication (RFC 7616 / 2617): MD5, MD5-sess, SHA-256, SHA-256-sess
 * with qop=auth or no qop.
 */
import { createHash, randomBytes } from "node:crypto";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parse a `WWW-Authenticate: Digest ...` header. Returns null for other schemes. */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m[1]))) params[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  if (!params.nonce) return null;
  return {
    realm: params.realm ?? "",
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
  };
}

/** Compute the `Authorization` header value answering a digest challenge. */
export function buildDigestAuthorization(
  challenge: DigestChallenge,
  opts: { username: string; password: string; method: string; uri: string; cnonce?: string; nc?: number },
): string {
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const hashName = algorithm.startsWith("SHA-256") ? "sha256" : "md5";
  const h = (s: string) => createHash(hashName).update(s).digest("hex");
  const cnonce = opts.cnonce ?? randomBytes(8).toString("hex");
  const nc = (opts.nc ?? 1).toString(16).padStart(8, "0");
  const qop = challenge.qop
    ?.split(",")
    .map((q) => q.trim())
    .find((q) => q === "auth");

  let ha1 = h(`${opts.username}:${challenge.realm}:${opts.password}`);
  if (algorithm.endsWith("-SESS")) ha1 = h(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = h(`${opts.method}:${opts.uri}`);
  const response = qop
    ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : h(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${opts.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${opts.uri}"`,
    `algorithm=${challenge.algorithm ?? "MD5"}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}
