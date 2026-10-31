/**
 * OAuth 1.0a request signing (RFC 5849): HMAC-SHA1/256/512, RSA-SHA1/256/512 and
 * PLAINTEXT, with the protocol parameters in the Authorization header, the query
 * string or a form-encoded body.
 */
import { createHash, createHmac, createSign, randomBytes } from "node:crypto";
import { OAUTH1_SIGNATURE_METHODS, type OAuth1Config, type OAuth1SignatureMethod } from "../types";

const FORM = "application/x-www-form-urlencoded";

export interface OAuth1SignableRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Buffer;
}

/** RFC 5849 section 3.6 percent-encoding (unreserved characters only). */
export function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Decode application/x-www-form-urlencoded pairs ("+" is a space). */
function formPairs(raw: string): [string, string][] {
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  };
  return raw
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? [decode(part), ""] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))];
    });
}

/** RFC 5849 3.4.1.2: scheme and host lowercased, default port and query removed. */
export function baseStringUri(url: URL): string {
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const defaultPort = (scheme === "http" && url.port === "80") || (scheme === "https" && url.port === "443");
  const host = url.hostname.toLowerCase() + (url.port && !defaultPort ? `:${url.port}` : "");
  return `${scheme}://${host}${url.pathname || "/"}`;
}

/** RFC 5849 3.4.1.3.2: encode, sort by name then value, join. */
export function normalizeParameters(pairs: [string, string][]): string {
  return pairs
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function hashName(method: OAuth1SignatureMethod): "sha1" | "sha256" | "sha512" {
  return method.endsWith("SHA512") ? "sha512" : method.endsWith("SHA256") ? "sha256" : "sha1";
}

export function signatureFor(
  method: OAuth1SignatureMethod,
  baseString: string,
  consumerSecret: string,
  tokenSecret: string,
  privateKey?: string,
): string {
  const key = `${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`;
  if (method === "PLAINTEXT") return key;
  if (method.startsWith("HMAC-"))
    return createHmac(hashName(method), key).update(baseString).digest("base64");
  if (!privateKey?.trim()) throw new Error(`OAuth 1.0 ${method} requires a PEM private key`);
  try {
    return createSign(`RSA-${hashName(method).toUpperCase()}`)
      .update(baseString)
      .sign(privateKey, "base64");
  } catch (err) {
    throw new Error(`OAuth 1.0 private key could not be used: ${(err as Error).message}`);
  }
}

export interface OAuth1Signed extends OAuth1SignableRequest {
  baseString: string;
  signature: string;
}

/**
 * Sign a request and place the oauth_* parameters as configured. The input is
 * not modified. `now` and `nonce` default to the current time and a random value.
 */
export function signOAuth1Request(input: OAuth1SignableRequest, config: OAuth1Config): OAuth1Signed {
  const method = config.signatureMethod ?? "HMAC-SHA1";
  if (!OAUTH1_SIGNATURE_METHODS.includes(method))
    throw new Error(`Unsupported OAuth 1.0 signature method: ${method}`);
  if (!config.consumerKey) throw new Error("OAuth 1.0 requires a consumer key");
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error(`Invalid URL for OAuth 1.0 signing: ${input.url}`);
  }
  const contentType = input.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const isForm = contentType.split(";")[0].trim().toLowerCase() === FORM;
  const addTo = config.addTo ?? "header";
  if (addTo === "body" && !isForm) {
    throw new Error("OAuth 1.0 parameters can only be added to an application/x-www-form-urlencoded body");
  }

  const oauth: [string, string][] = [
    ["oauth_consumer_key", config.consumerKey],
    ["oauth_signature_method", method],
    ["oauth_timestamp", config.timestamp?.trim() || String(Math.floor(Date.now() / 1000))],
    ["oauth_nonce", config.nonce?.trim() || randomBytes(16).toString("hex")],
  ];
  const version = config.version ?? "1.0";
  if (version) oauth.push(["oauth_version", version]);
  if (config.token) oauth.push(["oauth_token", config.token]);
  if (config.callback) oauth.push(["oauth_callback", config.callback]);
  if (config.verifier) oauth.push(["oauth_verifier", config.verifier]);
  // oauth_body_hash (draft-eaton-oauth-bodyhash) never applies to form bodies, which are signed as parameters.
  if (config.includeBodyHash && !isForm && method !== "PLAINTEXT") {
    oauth.push([
      "oauth_body_hash",
      createHash(hashName(method))
        .update(input.body ?? Buffer.alloc(0))
        .digest("base64"),
    ]);
  }
  const included = config.addEmptyParamsToSign ? oauth : oauth.filter(([, v]) => v !== "");

  const query = formPairs(url.search.slice(1));
  const body = isForm && input.body ? formPairs(input.body.toString("utf8")) : [];
  const baseString = [
    input.method.toUpperCase(),
    oauthEncode(baseStringUri(url)),
    oauthEncode(normalizeParameters([...query, ...body, ...included])),
  ].join("&");
  const signature = signatureFor(
    method,
    baseString,
    config.consumerSecret ?? "",
    config.tokenSecret ?? "",
    config.privateKey,
  );
  const params: [string, string][] = [...included, ["oauth_signature", signature]];

  const out: OAuth1Signed = { ...input, headers: input.headers.slice(), baseString, signature };
  if (addTo === "header") {
    const realm = config.realm ? [`realm="${oauthEncode(config.realm)}"`] : [];
    const fields = params.map(([k, v]) => `${oauthEncode(k)}="${oauthEncode(v)}"`);
    out.headers.push(["Authorization", `OAuth ${[...realm, ...fields].join(",")}`]);
  } else {
    const encoded = params.map(([k, v]) => `${oauthEncode(k)}=${oauthEncode(v)}`).join("&");
    if (addTo === "query") {
      url.search = url.search ? `${url.search.slice(1)}&${encoded}` : encoded;
      out.url = url.toString();
    } else {
      const existing = input.body?.toString("utf8") ?? "";
      out.body = Buffer.from(existing ? `${existing}&${encoded}` : encoded, "utf8");
      out.headers = out.headers.filter(([k]) => k.toLowerCase() !== "content-length");
    }
  }
  return out;
}
