/** Authorization-code request helpers: state, PKCE (RFC 7636) and the authorization URL. */
import { createHash, randomBytes } from "node:crypto";
import type { OAuth2Config } from "../types";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256" | "plain";
}

/** A 43-character verifier from 32 random bytes, and its challenge. */
export function createPkce(
  method: "S256" | "plain" = "S256",
  verifier = randomBytes(32).toString("base64url"),
): PkcePair {
  const challenge = method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
  return { verifier, challenge, method };
}

export const createState = () => randomBytes(32).toString("base64url");

export function buildAuthorizationUrl(
  o: OAuth2Config,
  opts: { state: string; redirectUri: string; pkce?: PkcePair },
): string {
  if (!o.authUrl) throw new Error("OAuth 2.0: authorization URL is required");
  if (!o.clientId) throw new Error("OAuth 2.0: client ID is required");
  let url: URL;
  try {
    url = new URL(o.authUrl);
  } catch {
    throw new Error(`OAuth 2.0: invalid authorization URL ${o.authUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("OAuth 2.0: the authorization URL must use http or https");
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", o.clientId);
  q.set("redirect_uri", opts.redirectUri);
  if (o.scope) q.set("scope", o.scope);
  q.set("state", opts.state);
  if (opts.pkce) {
    q.set("code_challenge", opts.pkce.challenge);
    q.set("code_challenge_method", opts.pkce.method);
  }
  return url.toString();
}
