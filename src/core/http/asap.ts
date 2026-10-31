/**
 * Atlassian ASAP (Authentication for Services and Projects): a short-lived JWT
 * signed with the service's private key and sent as a Bearer token.
 * https://s2sauth.bitbucket.io/spec/
 */
import { createPrivateKey, randomUUID, sign, constants } from "node:crypto";
import { ASAP_ALGORITHMS, type AsapAlgorithm, type AsapConfig } from "../types";

/** The ASAP spec caps token lifetime at one hour. */
export const ASAP_MAX_EXPIRY_SECONDS = 3600;
export const ASAP_DEFAULT_EXPIRY_SECONDS = 3600;
/** Registered claims Postbox sets itself; additional claims may not override them. */
const RESERVED_CLAIMS = new Set(["iss", "sub", "aud", "jti", "iat", "exp", "nbf"]);

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function digestFor(alg: AsapAlgorithm): string {
  return `sha${alg.slice(2)}`;
}

/** Parse "3600", "30m", "1h" or "45s" into seconds. */
export function parseExpiry(value: string | number | undefined): number {
  if (value === undefined || value === "") return ASAP_DEFAULT_EXPIRY_SECONDS;
  const m = /^\s*(\d+)\s*([smh]?)\s*$/i.exec(String(value));
  if (!m) throw new Error(`ASAP expiry must be seconds or a duration like 30m or 1h, got "${value}"`);
  const seconds =
    Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600 } as const)[m[2].toLowerCase() as "" | "s" | "m" | "h"];
  if (seconds < 1 || seconds > ASAP_MAX_EXPIRY_SECONDS)
    throw new Error(`ASAP tokens must expire within 1 to ${ASAP_MAX_EXPIRY_SECONDS} seconds`);
  return seconds;
}

function additionalClaims(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ASAP additional claims must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("ASAP additional claims must be a JSON object");
  const reserved = Object.keys(parsed).filter((k) => RESERVED_CLAIMS.has(k));
  if (reserved.length) throw new Error(`ASAP additional claims cannot set ${reserved.join(", ")}`);
  return parsed as Record<string, unknown>;
}

export interface AsapToken {
  token: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** Build and sign an ASAP token. `now` (ms) and `jti` are injectable for reproducible tests. */
export function createAsapToken(config: AsapConfig, now = Date.now(), jti: string = randomUUID()): AsapToken {
  const alg = config.algorithm ?? "RS256";
  if (!ASAP_ALGORITHMS.includes(alg)) throw new Error(`Unsupported ASAP algorithm: ${alg}`);
  const issuer = config.issuer?.trim();
  const keyId = config.keyId?.trim();
  const audience = (config.audience ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (!issuer) throw new Error("ASAP requires an issuer");
  if (!keyId) throw new Error("ASAP requires a key ID (kid)");
  if (!audience.length) throw new Error("ASAP requires at least one audience");
  // The spec requires the key ID to be a path under the issuer's key repository.
  if (!/^[\w.\-+/]+$/.test(keyId) || keyId.includes("..") || keyId.startsWith("/"))
    throw new Error("ASAP key ID must be a relative path of letters, digits and . _ - + /");
  if (!config.privateKey?.trim()) throw new Error("ASAP requires a PEM private key");

  let key;
  try {
    key = createPrivateKey(config.privateKey);
  } catch (err) {
    throw new Error(`ASAP private key could not be read: ${(err as Error).message}`);
  }
  const keyType = key.asymmetricKeyType;
  if (alg.startsWith("ES") ? keyType !== "ec" : keyType !== "rsa" && keyType !== "rsa-pss")
    throw new Error(`ASAP ${alg} needs ${alg.startsWith("ES") ? "an EC" : "an RSA"} private key`);

  const iat = Math.floor(now / 1000);
  const header = { alg, typ: "JWT", kid: keyId };
  const claims: Record<string, unknown> = {
    ...additionalClaims(config.additionalClaims),
    iss: issuer,
    ...(config.subject?.trim() ? { sub: config.subject.trim() } : {}),
    aud: audience.length === 1 ? audience[0] : audience,
    jti,
    iat,
    exp: iat + parseExpiry(config.expiry),
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(digestFor(alg), Buffer.from(input), {
    key,
    ...(alg.startsWith("PS")
      ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
      : {}),
    ...(alg.startsWith("ES") ? { dsaEncoding: "ieee-p1363" as const } : {}),
  });
  return { token: `${input}.${base64url(signature)}`, header, claims };
}
