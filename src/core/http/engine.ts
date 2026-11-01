/**
 * Server-side HTTP engine.
 *
 * Built directly on node:http / node:https (instead of fetch) so we can:
 *  - measure a timing breakdown (DNS, TCP, TLS, TTFB, download),
 *  - toggle TLS verification per request,
 *  - follow redirects manually, applying cookies and the host policy at every hop,
 *  - answer HTTP Digest challenges,
 *  - preserve raw header casing and order.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import { promisify } from "node:util";
import type { CookieInfo, HttpResponse, PreparedRequest, RedirectHop, Timings } from "../types";
import type { CookieJarStore } from "./cookies";
import { parseSetCookies } from "./cookies";
import { buildDigestAuthorization, parseDigestChallenge } from "./digest";
import { authenticateMessage, negotiateMessage, parseChallenge } from "./ntlm";
import { signAwsRequest } from "./aws-sigv4";
import { HostPolicy, HostPolicyError, OPEN_POLICY } from "./policy";
import { sendOnceH2 } from "./h2";
import { isProxyError, planConnection, tlsOptions, type TlsIdentity } from "./outbound";

export interface EngineOptions {
  /** Isolates OAuth token reuse between workspaces or standalone callers. */
  oauth2CacheScope?: string;
  cookieJar?: CookieJarStore;
  policy?: HostPolicy;
  signal?: AbortSignal;
  /** Encoded body cap (truncates) and per-stage decoded cap (rejects). Default 50 MB. */
  maxBodyBytes?: number;
}

export class RequestError extends Error {
  constructor(
    message: string,
    public code: string,
    public timings?: Partial<Timings>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

// Only these non-credential headers survive an origin boundary. Unknown/custom
// headers may contain API keys, so stripping a fixed credential denylist is insufficient.
const CROSS_ORIGIN_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-length",
  "user-agent",
]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BODY = Number(process.env.RESPONSE_MAX_BYTES) || 50 * 1024 * 1024;

const round = (n: number) => Math.max(0, Math.round(n * 100) / 100);

function hasHeader(headers: [string, string][], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === n);
}

function withoutHeader(headers: [string, string][], ...names: string[]): [string, string][] {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return headers.filter(([k]) => !set.has(k.toLowerCase()));
}

/** Text-like content types are decoded to UTF-8; anything else is treated as binary. */
export function isTextContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return (
    c === "" ||
    c.startsWith("text/") ||
    /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html|svg/.test(c)
  );
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 1024);
  for (const b of sample) if (b === 0) return true;
  return false;
}

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

function rethrowBodyLimit(err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
    throw new RequestError("Decoded response exceeds the response size limit", "ERESPONSETOOLARGE");
  }
}

async function decompress(
  buf: Buffer,
  encoding: string | undefined,
  maxOutputLength: number,
): Promise<Buffer> {
  if (!encoding || buf.length === 0) return buf;
  const encodings = encoding
    .toLowerCase()
    .split(",")
    .map((e) => e.trim())
    .reverse();
  let out = buf;
  for (const enc of encodings) {
    try {
      if (enc === "gzip" || enc === "x-gzip")
        out = await gunzip(out, { maxOutputLength, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc === "deflate") {
        try {
          out = await inflate(out, { maxOutputLength });
        } catch (err) {
          rethrowBodyLimit(err);
          out = await inflateRaw(out, { maxOutputLength });
        }
      } else if (enc === "br") out = await brotliDecompress(out, { maxOutputLength });
      else if (enc === "zstd" && "zstdDecompress" in zlib) {
        const decode = promisify(zlib.zstdDecompress as typeof zlib.brotliDecompress);
        out = await decode(out, { maxOutputLength });
      }
    } catch (err) {
      if (err instanceof RequestError) throw err;
      rethrowBodyLimit(err);
      return buf; // leave the payload as-is if it cannot be decoded
    }
  }
  return out;
}

export interface SingleResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  rawHeaders: [string, string][];
  trailers?: [string, string][];
  body: Buffer;
  truncated: boolean;
  timings: Omit<Timings, "total">;
  remoteAddress?: string;
}

/** Perform exactly one HTTP exchange (no redirects). */
function sendOnce(
  method: string,
  url: URL,
  headers: [string, string][],
  body: Buffer | undefined,
  opts: {
    verifySsl: boolean;
    timeoutMs: number;
    policy: HostPolicy;
    signal?: AbortSignal;
    maxBodyBytes: number;
    /** Keep-alive agent for connection-bound auth (NTLM); otherwise a fresh socket per exchange. */
    agent?: http.Agent;
    /** Connect to this Unix socket / named pipe instead of resolving the URL host. */
    socketPath?: string;
    /** TLS identity for a Unix-socket https target (direct connections use the connection plan). */
    identity?: TlsIdentity;
  },
): Promise<SingleResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const start = performance.now();
    let dnsAt = start;
    let tcpAt = 0;
    let tlsAt = 0;
    let firstByteAt = 0;
    let settled = false;

    // DNS lookup hook: enforce the host policy against the resolved IP (prevents DNS rebinding tricks).
    const lookup: net.LookupFunction = (hostname, options, cb) => {
      dns.lookup(hostname, options, (err, address, family) => {
        dnsAt = performance.now();
        if (err) return cb(err, address as string, family);
        const addrs = Array.isArray(address) ? address : [{ address, family }];
        for (const a of addrs) {
          const reason = opts.policy.check(hostname, a.address);
          if (reason) return cb(new HostPolicyError(reason), "", 4);
        }
        cb(null, address as string, family);
      });
    };

    // Raw header arrays preserve casing/order, but Node then won't add Host for us.
    const headerObj: string[] = [];
    if (!hasHeader(headers, "host")) headerObj.push("Host", url.host);
    for (const [k, v] of headers) headerObj.push(k, v);

    // Proxy and TLS profile selection (a Unix socket bypasses both).
    const plan = opts.socketPath
      ? null
      : planConnection(
          url,
          {
            policy: opts.policy,
            lookup,
            verifySsl: opts.verifySsl,
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
          },
          `${url.pathname}${url.search}`,
        );
    if (plan) for (const [k, v] of plan.headers) headerObj.push(k, v);
    const lib = plan ? (plan.secure ? https : http) : isHttps ? https : http;

    const req = lib.request(
      {
        method,
        ...(plan
          ? { ...plan.options, path: plan.path, protocol: plan.secure ? "https:" : "http:" }
          : {
              protocol: url.protocol,
              socketPath: opts.socketPath,
              path: `${url.pathname}${url.search}`,
              rejectUnauthorized: opts.verifySsl,
              servername: net.isIP(url.hostname) ? undefined : url.hostname,
              ...tlsOptions(opts.identity),
            }),
        headers: headerObj as unknown as http.OutgoingHttpHeaders,
        agent: opts.agent ?? (plan?.options.createConnection ? undefined : false),
        setHost: false,
      },
      (res) => {
        firstByteAt = performance.now();
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (received + chunk.length > opts.maxBodyBytes) {
            truncated = true;
            const remaining = opts.maxBodyBytes - received;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            received = opts.maxBodyBytes;
            res.destroy();
            finish();
            return;
          }
          received += chunk.length;
          chunks.push(chunk);
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const end = performance.now();
          const rawHeaders: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            rawHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          const connectBase = tcpAt || dnsAt;
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            httpVersion: res.httpVersion,
            rawHeaders,
            body: Buffer.concat(chunks),
            truncated,
            remoteAddress: res.socket?.remoteAddress,
            timings: {
              dns: round(dnsAt - start),
              tcp: round(tcpAt ? tcpAt - dnsAt : 0),
              tls: round(tlsAt ? tlsAt - connectBase : 0),
              ttfb: round(firstByteAt - (tlsAt || tcpAt || dnsAt)),
              download: round(end - firstByteAt),
            },
          });
        };
        res.on("end", finish);
        res.on("error", (err) => fail(err));
      },
    );

    req.on("socket", (socket) => {
      socket.on("lookup", () => (dnsAt = performance.now()));
      socket.on("connect", () => (tcpAt = performance.now()));
      socket.on("secureConnect", () => (tlsAt = performance.now()));
    });

    const timer = setTimeout(() => {
      fail(new RequestError(`Request timed out after ${opts.timeoutMs} ms`, "ETIMEDOUT"));
      req.destroy();
    }, opts.timeoutMs);

    const onAbort = () => {
      fail(new RequestError("Request was cancelled", "ECANCELLED"));
      req.destroy();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Cancellation can arrive while the caller awaits cookie-jar access.
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err instanceof RequestError || err instanceof HostPolicyError) return reject(err);
      if (isProxyError(err)) return reject(new RequestError(err.message, err.code));
      const code = (err as NodeJS.ErrnoException).code ?? "EREQUEST";
      reject(new RequestError(friendlyError(err, code, url), code));
    }

    req.on("error", fail);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function friendlyError(err: Error, code: string, url: URL): string {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not resolve host "${url.hostname}"`;
    case "ECONNREFUSED":
      return `Connection refused by ${url.host}`;
    case "ECONNRESET":
      return `Connection reset by ${url.host}`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `SSL error (${code}): ${err.message}. Disable "Verify SSL" to ignore certificate errors.`;
    default:
      return err.message || code;
  }
}

/**
 * Send a prepared request, following redirects according to its settings.
 * Throws RequestError on network failures and HostPolicyError when blocked.
 */
export async function sendRequest(
  prepared: PreparedRequest,
  options: EngineOptions = {},
): Promise<HttpResponse> {
  const policy = options.policy ?? OPEN_POLICY;
  const settings = prepared.settings;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RequestError("Response size limit must be a positive integer", "EINVALIDLIMIT");
  }
  const overallStart = performance.now();
  const redirects: RedirectHop[] = [];
  const responseCookies: CookieInfo[] = [];

  let method = prepared.method.toUpperCase();
  let url: URL;
  try {
    url = new URL(prepared.url);
  } catch {
    throw new RequestError(`Invalid URL: ${prepared.url}`, "EINVALIDURL");
  }
  let headers = prepared.headers.slice();
  let body = prepared.body;
  let socketPath = settings.socketPath;
  let digestTried = false;
  let digestAllowed = true;
  // NTLM authenticates a connection, so its handshake runs on one dedicated keep-alive socket.
  let ntlmState: "idle" | "negotiating" | "authenticating" | "done" = prepared.ntlm ? "idle" : "done";
  let ntlmAgent: http.Agent | undefined;
  const closeNtlmAgent = () => {
    ntlmAgent?.destroy();
    ntlmAgent = undefined;
  };

  try {
    for (let hop = 0; ; hop++) {
      if (options.signal?.aborted) throw new RequestError("Request was cancelled", "ECANCELLED");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RequestError(`Unsupported protocol "${url.protocol}"`, "EPROTOCOL");
      }
      // A socket endpoint replaces DNS and TCP entirely, so it is checked instead of the host.
      if (socketPath) policy.assertSocket(socketPath);
      else policy.assertTarget(url.hostname, !!policy.network?.proxyFor(url));
      const proxied = !socketPath && !!policy.network?.proxyFor(url);
      if (proxied && prepared.ntlm)
        throw new RequestError(
          "NTLM authentication cannot be used through the outbound proxy; add the host to the proxy bypass list.",
          "EPROXYUNSUPPORTED",
        );

      // Merge jar cookies with any Cookie header the user set explicitly.
      let hopHeaders = headers;
      if (options.cookieJar && settings.useCookieJar) {
        const jarCookies = await options.cookieJar.getCookieHeader(url.toString());
        if (jarCookies) {
          const userCookieHeader = headers.find(([k]) => k.toLowerCase() === "cookie")?.[1];
          hopHeaders = withoutHeader(headers, "cookie");
          hopHeaders.push(["Cookie", userCookieHeader ? `${userCookieHeader}; ${jarCookies}` : jarCookies]);
        }
      }
      if (body && !hasHeader(hopHeaders, "content-length")) {
        hopHeaders = [...hopHeaders, ["Content-Length", String(body.length)]];
      }

      if (ntlmState === "idle" && !hasHeader(hopHeaders, "authorization")) {
        closeNtlmAgent();
        const Agent = url.protocol === "https:" ? https.Agent : http.Agent;
        ntlmAgent = new Agent({ keepAlive: true, maxSockets: 1 });
        hopHeaders = [...hopHeaders, ["Authorization", `NTLM ${negotiateMessage()}`]];
        ntlmState = "negotiating";
      }

      const httpVersion = settings.httpVersion ?? "http1";
      if (httpVersion === "http2" && proxied && url.protocol === "http:") {
        throw new RequestError(
          "Cleartext HTTP/2 cannot be sent through the outbound proxy; use https, HTTP/1.1 or bypass the proxy.",
          "EH2UNSUPPORTED",
        );
      }
      if (httpVersion === "http2" && (socketPath || prepared.ntlm)) {
        throw new RequestError(
          `HTTP/2 cannot be used with ${socketPath ? "a Unix socket or named pipe" : "NTLM authentication"}; choose Auto or HTTP/1.1.`,
          "EH2UNSUPPORTED",
        );
      }
      // Auto/HTTP/2 use their own connection; sockets and NTLM (connection-bound) stay on HTTP/1.1.
      const h2Res =
        httpVersion !== "http1" && !socketPath && !prepared.ntlm
          ? await sendOnceH2(method, url, hopHeaders, body, {
              mode: httpVersion,
              verifySsl: settings.verifySsl,
              timeoutMs: settings.timeoutMs,
              policy,
              signal: options.signal,
              maxBodyBytes,
            })
          : null;

      const res =
        h2Res ??
        (await sendOnce(method, url, hopHeaders, body, {
          verifySsl: settings.verifySsl,
          timeoutMs: settings.timeoutMs,
          policy,
          signal: options.signal,
          maxBodyBytes,
          socketPath,
          identity: socketPath ? policy.network?.tlsFor(url.hostname, Number(url.port) || 443) : undefined,
          agent: ntlmState === "negotiating" || ntlmState === "authenticating" ? ntlmAgent : undefined,
        }));

      const setCookies = res.rawHeaders.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
      if (setCookies.length) {
        responseCookies.push(...parseSetCookies(setCookies, url.toString()));
        if (options.cookieJar && settings.useCookieJar)
          await options.cookieJar.storeSetCookies(setCookies, url.toString());
      }

      const header = (name: string) => res.rawHeaders.find(([k]) => k.toLowerCase() === name)?.[1];

      if (ntlmState === "negotiating" && prepared.ntlm) {
        const challenge =
          res.status === 401
            ? res.rawHeaders
                .filter(([k]) => k.toLowerCase() === "www-authenticate")
                .map(([, v]) => parseChallenge(v))
                .find((c) => c !== null)
            : undefined;
        if (challenge) {
          ntlmState = "authenticating";
          const auth = `NTLM ${authenticateMessage(prepared.ntlm, challenge)}`;
          headers = [...withoutHeader(headers, "authorization"), ["Authorization", auth]];
          hop--;
          continue;
        }
        ntlmState = "done";
      } else if (ntlmState === "authenticating") {
        // The AUTHENTICATE message is bound to that connection; never resend it elsewhere.
        headers = withoutHeader(headers, "authorization");
        ntlmState = "done";
        closeNtlmAgent();
      }

      // Digest challenge/response: retry once with credentials.
      if (res.status === 401 && prepared.digest && digestAllowed && !digestTried) {
        const challenge = parseDigestChallenge(
          res.rawHeaders
            .filter(([k]) => k.toLowerCase() === "www-authenticate")
            .map(([, v]) => v)
            .find((v) => /^\s*digest/i.test(v)) ?? "",
        );
        if (challenge) {
          digestTried = true;
          headers = withoutHeader(headers, "authorization");
          headers.push([
            "Authorization",
            buildDigestAuthorization(challenge, {
              ...prepared.digest,
              method,
              uri: `${url.pathname}${url.search}`,
            }),
          ]);
          hop--;
          continue;
        }
      }

      const location = header("location");
      if (settings.followRedirects && REDIRECT_CODES.has(res.status) && location) {
        if (hop >= settings.maxRedirects) {
          throw new RequestError(`Exceeded maximum of ${settings.maxRedirects} redirects`, "EMAXREDIRECTS");
        }
        redirects.push({ url: url.toString(), status: res.status });
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol === "http:") {
          throw new RequestError("Blocked HTTPS-to-HTTP redirect", "EREDIRECTDOWNGRADE");
        }
        // 303 always becomes GET; 301/302 become GET for non-GET/HEAD (browser behaviour).
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")
        ) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = undefined;
          headers = withoutHeader(headers, "content-type", "content-length");
        }
        const sameOrigin = next.origin === url.origin;
        // A new hop on the same origin uses a new connection, which needs its own NTLM handshake.
        if (prepared.ntlm && ntlmState === "done" && sameOrigin) ntlmState = "idle";
        // Never forward credentials to a different origin.
        if (!sameOrigin) {
          // An absolute redirect elsewhere leaves the socket and goes through normal host policy.
          socketPath = undefined;
          headers = headers.filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase()));
          digestAllowed = false;
        }
        headers = withoutHeader(headers, "host");
        url = next;
        // AWS signatures cover the method, URL and body; re-sign for the new hop on the same origin.
        if (prepared.awsv4 && sameOrigin) {
          const signed = signAwsRequest({ method, url: url.toString(), headers, body }, prepared.awsv4);
          headers = signed.headers;
          url = new URL(signed.url);
        }
        continue;
      }

      const decoded = await decompress(res.body, header("content-encoding"), maxBodyBytes);
      const contentType = header("content-type") ?? "";
      const isBinary = !isTextContentType(contentType) || looksBinary(decoded);
      const headersSize = res.rawHeaders.reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
      const total = round(performance.now() - overallStart);

      return {
        status: res.status,
        statusText: res.statusText,
        httpVersion: res.httpVersion,
        headers: res.rawHeaders,
        ...(res.trailers?.length ? { trailers: res.trailers } : {}),
        bodyBase64: decoded.toString("base64"),
        bodyText: isBinary ? "" : decoded.toString("utf8"),
        isBinary,
        contentType,
        size: decoded.length,
        truncated: res.truncated,
        headersSize,
        timings: { ...res.timings, total },
        url: url.toString(),
        redirects,
        cookies: responseCookies,
        remoteAddress: res.remoteAddress,
      };
    }
  } finally {
    closeNtlmAgent();
  }
}
