/**
 * Authentication helpers: inheritance resolution and applying auth to a request.
 */
import type { AuthConfig, HawkAlgorithm, OAuth2Config, PreparedRequest } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import type { Resolver } from "../variables/resolver";
import { sendRequest, type EngineOptions } from "./engine";
import { createHash } from "node:crypto";
import { buildEdgeGridAuthHeader } from "./edgegrid";
import { signAwsRequest } from "./aws-sigv4";
import { signOAuth1Request } from "./oauth1";
import { createAsapToken } from "./asap";
import { buildHawkHeader } from "./hawk";

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
    case "edgegrid": {
      const e = auth.edgegrid;
      return {
        type: "edgegrid",
        edgegrid: {
          ...e,
          clientToken: r.resolve(e.clientToken),
          clientSecret: r.resolve(e.clientSecret),
          accessToken: r.resolve(e.accessToken),
          baseURL: e.baseURL !== undefined ? r.resolve(e.baseURL) : undefined,
          headersToSign: e.headersToSign !== undefined ? r.resolve(e.headersToSign) : undefined,
          nonce: e.nonce !== undefined ? r.resolve(e.nonce) : undefined,
          timestamp: e.timestamp !== undefined ? r.resolve(e.timestamp) : undefined,
        },
      };
    }
    case "hawk": {
      const h = auth.hawk;
      return {
        type: "hawk",
        hawk: {
          ...h,
          authId: r.resolve(h.authId),
          authKey: r.resolve(h.authKey),
          algorithm: (r.resolve(h.algorithm) as HawkAlgorithm) || "sha256",
          user: h.user !== undefined ? r.resolve(h.user) : undefined,
          nonce: h.nonce !== undefined ? r.resolve(h.nonce) : undefined,
          ext: h.ext !== undefined ? r.resolve(h.ext) : undefined,
          app: h.app !== undefined ? r.resolve(h.app) : undefined,
          dlg: h.dlg !== undefined ? r.resolve(h.dlg) : undefined,
          timestamp: h.timestamp !== undefined ? r.resolve(h.timestamp) : undefined,
          includePayloadHash: h.includePayloadHash,
        },
      };
    }
    case "asap": {
      const a = auth.asap;
      const opt = (v: string | undefined) => (v !== undefined ? r.resolve(v) : undefined);
      return {
        type: "asap",
        asap: {
          ...a,
          issuer: r.resolve(a.issuer),
          subject: opt(a.subject),
          audience: r.resolve(a.audience),
          keyId: r.resolve(a.keyId),
          privateKey: r.resolve(a.privateKey),
          expiry: opt(a.expiry),
          additionalClaims: opt(a.additionalClaims),
        },
      };
    }
    case "oauth1": {
      const o = auth.oauth1;
      const opt = (v: string | undefined) => (v !== undefined ? r.resolve(v) : undefined);
      return {
        type: "oauth1",
        oauth1: {
          ...o,
          consumerKey: r.resolve(o.consumerKey),
          consumerSecret: r.resolve(o.consumerSecret),
          token: opt(o.token),
          tokenSecret: opt(o.tokenSecret),
          privateKey: opt(o.privateKey),
          timestamp: opt(o.timestamp),
          nonce: opt(o.nonce),
          version: opt(o.version),
          realm: opt(o.realm),
          callback: opt(o.callback),
          verifier: opt(o.verifier),
        },
      };
    }
    case "awsv4": {
      const a = auth.awsv4;
      const opt = (v: string | undefined) => (v !== undefined ? r.resolve(v) : undefined);
      return {
        type: "awsv4",
        awsv4: {
          ...a,
          accessKey: r.resolve(a.accessKey),
          secretKey: r.resolve(a.secretKey),
          sessionToken: opt(a.sessionToken),
          region: opt(a.region),
          service: r.resolve(a.service),
          timestamp: opt(a.timestamp),
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
  contextKey?: string;
}

/** In-process token cache so repeated sends/runs don't fetch a new token every time. */
const tokenCache = new Map<string, { token: OAuth2Token; expiresAt: number }>();
const MAX_CACHE_SIZE = 256;
const MAX_CACHE_TTL = 60 * 60 * 1000;
const DEFAULT_TOKEN_TTL = 5 * 60 * 1000;

function cacheKey(o: OAuth2Config, scope = "standalone") {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        o.grantType,
        o.accessTokenUrl,
        o.clientId,
        o.clientSecret,
        o.scope,
        o.username ?? "",
        o.password ?? "",
        o.clientAuthentication,
      ]),
    )
    .digest("hex");
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
  const ttl =
    json.expires_in === undefined
      ? DEFAULT_TOKEN_TTL
      : Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.min(expiresIn * 1000, MAX_CACHE_TTL)
        : 0;
  return {
    accessToken: String(json.access_token),
    tokenType: String(json.token_type ?? "Bearer"),
    expiresAt: Date.now() + ttl,
    raw: json,
    contextKey: cacheKey(o, engine.oauth2CacheScope),
  };
}

/** Returns a valid token for the config, fetching (and caching) a new one when needed. */
export async function getOAuth2Token(o: OAuth2Config, engine?: EngineOptions): Promise<OAuth2Token | null> {
  const fresh = (exp?: number) =>
    typeof exp === "number" &&
    Number.isFinite(exp) &&
    exp <= Date.now() + MAX_CACHE_TTL &&
    exp - 30_000 > Date.now();
  const key = cacheKey(o, engine?.oauth2CacheScope);
  if (o.grantType === "manual" || (o.accessToken && o.tokenContext === key && fresh(o.expiresAt))) {
    return o.accessToken
      ? {
          accessToken: o.accessToken,
          tokenType: o.tokenType ?? "Bearer",
          expiresAt: o.expiresAt,
          contextKey: o.tokenContext,
          raw: {},
        }
      : null;
  }
  for (const [cachedKey, entry] of tokenCache) {
    if (!fresh(entry.expiresAt)) tokenCache.delete(cachedKey);
  }
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.token;
  }
  const token = await fetchOAuth2Token(o, engine);
  tokenCache.set(key, { token, expiresAt: Math.min(token.expiresAt!, Date.now() + MAX_CACHE_TTL) });
  while (tokenCache.size > MAX_CACHE_SIZE) tokenCache.delete(tokenCache.keys().next().value!);
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
  offline = false,
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
        // String-based so it also works on not-yet-valid URLs (code generation with unresolved variables).
        const [base, hash] = req.url.split("#");
        const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        req.url = `${base}${base.includes("?") ? "&" : "?"}${pair}${hash !== undefined ? `#${hash}` : ""}`;
      } else setHeader(req, key, value);
      return {};
    }
    case "digest":
      req.digest = { username: auth.digest.username, password: auth.digest.password };
      return {};
    case "oauth2": {
      if (hasAuthHeader) return {};
      if (offline) {
        const t = auth.oauth2.accessToken || "<access-token>";
        setHeader(req, "Authorization", auth.oauth2.headerPrefix ? `${auth.oauth2.headerPrefix} ${t}` : t);
        return {};
      }
      const token = await getOAuth2Token(auth.oauth2, engine);
      if (token) {
        const prefix = auth.oauth2.headerPrefix ?? "Bearer";
        setHeader(req, "Authorization", prefix ? `${prefix} ${token.accessToken}` : token.accessToken);
      }
      return { oauth2Token: token ?? undefined };
    }
    case "edgegrid": {
      if (hasAuthHeader) return {};
      const { clientToken, clientSecret, accessToken } = auth.edgegrid;
      if (offline) {
        const ct = clientToken || "<client-token>";
        const cs = clientSecret || "<client-secret>";
        const at = accessToken || "<access-token>";
        const header = buildEdgeGridAuthHeader(
          { ...auth.edgegrid, clientToken: ct, clientSecret: cs, accessToken: at },
          { method: req.method, url: req.url, headers: req.headers, body: req.body },
        );
        setHeader(req, "Authorization", header);
        return {};
      }
      if (!clientToken || !clientSecret || !accessToken) {
        throw new Error("Akamai EdgeGrid: clientToken, clientSecret, and accessToken are required");
      }
      const header = buildEdgeGridAuthHeader(auth.edgegrid, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
      });
      setHeader(req, "Authorization", header);
      return {};
    }
    case "hawk": {
      if (!hasAuthHeader) {
        if (offline && (!auth.hawk.authId || !auth.hawk.authKey)) {
          const id = auth.hawk.authId || "<auth-id>";
          setHeader(req, "Authorization", `Hawk id="${id}", ts="0", nonce="offline", mac="<mac>"`);
          return {};
        }
        const header = buildHawkHeader(req, auth.hawk);
        setHeader(req, "Authorization", header);
      }
      return {};
    }
    case "asap": {
      if (hasAuthHeader) return {};
      try {
        setHeader(req, "Authorization", `Bearer ${createAsapToken(auth.asap).token}`);
      } catch (err) {
        // Code generation may run before the key variable is resolved.
        if (!offline) throw err;
        setHeader(req, "Authorization", "Bearer <asap-token>");
      }
      return {};
    }
    case "oauth1": {
      const addTo = auth.oauth1.addTo ?? "header";
      if (hasAuthHeader && addTo === "header") return {};
      let signed;
      try {
        signed = signOAuth1Request(req, auth.oauth1);
      } catch (err) {
        // Code generation may run before variables make the URL or key valid.
        if (!offline) throw err;
        setHeader(
          req,
          "Authorization",
          'OAuth oauth_consumer_key="<consumer-key>",oauth_signature="<signature>"',
        );
        return {};
      }
      req.url = signed.url;
      req.headers = signed.headers;
      req.body = signed.body;
      return {};
    }
    case "awsv4": {
      if (hasAuthHeader) return {};
      const config = offline
        ? {
            ...auth.awsv4,
            accessKey: auth.awsv4.accessKey || "<access-key>",
            secretKey: auth.awsv4.secretKey || "<secret-key>",
            service: auth.awsv4.service || "<service>",
          }
        : auth.awsv4;
      let signed;
      try {
        signed = signAwsRequest(req, config);
      } catch (err) {
        // Code generation may run before variables make the URL valid.
        if (!offline) throw err;
        setHeader(
          req,
          "Authorization",
          "AWS4-HMAC-SHA256 Credential=<credential>, SignedHeaders=<headers>, Signature=<signature>",
        );
        return {};
      }
      req.url = signed.url;
      req.headers = signed.headers;
      if (!offline) req.awsv4 = auth.awsv4;
      return {};
    }
    default:
      return {};
  }
}
