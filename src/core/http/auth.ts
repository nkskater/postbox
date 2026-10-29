/**
 * Authentication helpers: inheritance resolution and applying auth to a request.
 */
import type { AuthConfig, OAuth2Config, PreparedRequest } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import type { Resolver } from "../variables/resolver";
import { sendRequest, type EngineOptions } from "./engine";

/**
 * Resolve the effective auth from an outermost → innermost chain
 * (collection, folders..., request). The innermost non-"inherit" entry wins.
 */
export function resolveEffectiveAuth(chain: (AuthConfig | undefined)[]): AuthConfig {
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i];
    if (a && a.type !== "inherit") return a;
  }
  return { type: "none" };
}

/** Resolve {{variables}} in every string field of an auth config. */
export function resolveAuth(auth: AuthConfig, r: Resolver): AuthConfig {
  switch (auth.type) {
    case "bearer":
      return { type: "bearer", bearer: { token: r.resolve(auth.bearer.token), prefix: auth.bearer.prefix } };
    case "basic":
      return {
        type: "basic",
        basic: { username: r.resolve(auth.basic.username), password: r.resolve(auth.basic.password) },
      };
    case "apikey":
      return {
        type: "apikey",
        apikey: { key: r.resolve(auth.apikey.key), value: r.resolve(auth.apikey.value), in: auth.apikey.in },
      };
    case "digest":
      return {
        type: "digest",
        digest: { username: r.resolve(auth.digest.username), password: r.resolve(auth.digest.password) },
      };
    case "oauth2": {
      const o = auth.oauth2;
      return {
        type: "oauth2",
        oauth2: {
          ...o,
          accessTokenUrl: r.resolve(o.accessTokenUrl),
          clientId: r.resolve(o.clientId),
          clientSecret: r.resolve(o.clientSecret),
          scope: r.resolve(o.scope),
          username: r.resolve(o.username),
          password: r.resolve(o.password),
          accessToken: r.resolve(o.accessToken),
        },
      };
    }
    default:
      return auth;
  }
}

export interface OAuth2Token {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  raw: Record<string, unknown>;
}

/** In-process token cache so repeated sends/runs don't fetch a new token every time. */
const tokenCache = new Map<string, OAuth2Token>();

function cacheKey(o: OAuth2Config) {
  return [o.grantType, o.accessTokenUrl, o.clientId, o.scope, o.username ?? ""].join("|");
}

export function clearOAuth2Cache() {
  tokenCache.clear();
}

/** Request a token from the token endpoint (client_credentials or password grant). */
export async function fetchOAuth2Token(o: OAuth2Config, engine: EngineOptions = {}): Promise<OAuth2Token> {
  if (!o.accessTokenUrl) throw new Error("OAuth 2.0: access token URL is required");
  const form = new URLSearchParams();
  form.set("grant_type", o.grantType);
  if (o.scope) form.set("scope", o.scope);
  if (o.grantType === "password") {
    form.set("username", o.username ?? "");
    form.set("password", o.password ?? "");
  }
  const headers: [string, string][] = [
    ["Content-Type", "application/x-www-form-urlencoded"],
    ["Accept", "application/json"],
  ];
  if (o.clientAuthentication === "body") {
    form.set("client_id", o.clientId);
    if (o.clientSecret) form.set("client_secret", o.clientSecret);
  } else {
    const cred = Buffer.from(
      `${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`,
    ).toString("base64");
    headers.push(["Authorization", `Basic ${cred}`]);
  }
  const res = await sendRequest(
    {
      method: "POST",
      url: o.accessTokenUrl,
      headers,
      body: Buffer.from(form.toString()),
      settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
    },
    { ...engine, cookieJar: undefined },
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.bodyText);
  } catch {
    json = Object.fromEntries(new URLSearchParams(res.bodyText));
  }
  if (res.status >= 400 || !json.access_token) {
    throw new Error(`OAuth 2.0 token request failed (${res.status}): ${res.bodyText.slice(0, 300)}`);
  }
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: String(json.access_token),
    tokenType: String(json.token_type ?? "Bearer"),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    raw: json,
  };
}

/** Returns a valid token for the config, fetching (and caching) a new one when needed. */
export async function getOAuth2Token(o: OAuth2Config, engine?: EngineOptions): Promise<OAuth2Token | null> {
  const fresh = (exp?: number) => !exp || exp - 30_000 > Date.now();
  if (o.grantType === "manual" || (o.accessToken && fresh(o.expiresAt))) {
    return o.accessToken
      ? { accessToken: o.accessToken, tokenType: o.tokenType ?? "Bearer", expiresAt: o.expiresAt, raw: {} }
      : null;
  }
  const key = cacheKey(o);
  const cached = tokenCache.get(key);
  if (cached && fresh(cached.expiresAt)) return cached;
  const token = await fetchOAuth2Token(o, engine);
  tokenCache.set(key, token);
  return token;
}

function setHeader(req: PreparedRequest, name: string, value: string) {
  req.headers = req.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  req.headers.push([name, value]);
}

/**
 * Apply a resolved auth config to a prepared request. Explicit request headers win:
 * if the user already set an Authorization header, header-based auth is skipped.
 */
export async function applyAuth(
  req: PreparedRequest,
  auth: AuthConfig,
  engine?: EngineOptions,
): Promise<{ oauth2Token?: OAuth2Token }> {
  const hasAuthHeader = req.headers.some(([k]) => k.toLowerCase() === "authorization");
  switch (auth.type) {
    case "bearer": {
      if (!hasAuthHeader && auth.bearer.token)
        setHeader(req, "Authorization", `${auth.bearer.prefix || "Bearer"} ${auth.bearer.token}`);
      return {};
    }
    case "basic": {
      if (!hasAuthHeader) {
        const cred = Buffer.from(`${auth.basic.username}:${auth.basic.password}`, "utf8").toString("base64");
        setHeader(req, "Authorization", `Basic ${cred}`);
      }
      return {};
    }
    case "apikey": {
      const { key, value } = auth.apikey;
      if (!key) return {};
      if (auth.apikey.in === "query") {
        const u = new URL(req.url);
        u.searchParams.append(key, value);
        req.url = u.toString();
      } else setHeader(req, key, value);
      return {};
    }
    case "digest":
      req.digest = { username: auth.digest.username, password: auth.digest.password };
      return {};
    case "oauth2": {
      if (hasAuthHeader) return {};
      const token = await getOAuth2Token(auth.oauth2, engine);
      if (token) {
        const prefix = auth.oauth2.headerPrefix ?? "Bearer";
        setHeader(req, "Authorization", prefix ? `${prefix} ${token.accessToken}` : token.accessToken);
      }
      return { oauth2Token: token ?? undefined };
    }
    default:
      return {};
  }
}
