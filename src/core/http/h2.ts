/**
 * HTTP/2 transport for a single exchange (no redirects, no retries).
 *
 * Mirrors sendOnce in engine.ts: the same host-policy DNS hook, timeout, cancellation
 * and body cap, plus response trailers. One connection per exchange, always closed.
 */
import dns from "node:dns";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import type { HttpVersionMode } from "../types";
import type { SingleResponse } from "./engine";
import { RequestError } from "./engine";
import { HostPolicyError, type HostPolicy } from "./policy";

export interface H2Options {
  mode: Exclude<HttpVersionMode, "http1">;
  verifySsl: boolean;
  timeoutMs: number;
  policy: HostPolicy;
  signal?: AbortSignal;
  maxBodyBytes: number;
}

/** Headers that are connection-specific in HTTP/1.1 and forbidden in HTTP/2 (RFC 9113 §8.2.2). */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const round = (n: number) => Math.round(n * 100) / 100;

/** Request headers valid for HTTP/2: lowercase names, no connection-specific fields. */
export function toH2Headers(headers: [string, string][], authority: string): http2.OutgoingHttpHeaders {
  const out: http2.OutgoingHttpHeaders = {};
  let host: string | undefined;
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === "host") {
      host = value;
      continue;
    }
    if (CONNECTION_HEADERS.has(key)) continue;
    // TE is only allowed with the value "trailers".
    if (key === "te" && value.trim().toLowerCase() !== "trailers") continue;
    const existing = out[key];
    out[key] =
      existing === undefined
        ? value
        : Array.isArray(existing)
          ? [...existing, value]
          : [String(existing), value];
  }
  out[":authority"] = host ?? authority;
  return out;
}

/**
 * Perform one HTTP/2 exchange. Resolves to null when mode is "auto" and the server did not
 * negotiate h2 (or the URL is plain http), so the caller can use the HTTP/1.1 transport.
 */
export async function sendOnceH2(
  method: string,
  url: URL,
  headers: [string, string][],
  body: Buffer | undefined,
  opts: H2Options,
): Promise<SingleResponse | null> {
  const isHttps = url.protocol === "https:";
  // Cleartext HTTP/2 needs prior knowledge, so it is only attempted when explicitly selected.
  if (!isHttps && opts.mode === "auto") return null;

  const start = performance.now();
  let dnsAt = start;
  let tcpAt = 0;
  let tlsAt = 0;
  let firstByteAt = 0;

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

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (isHttps ? 443 : 80);

  const socket = await connect();
  if (isHttps) {
    const alpn = (socket as tls.TLSSocket).alpnProtocol;
    if (alpn !== "h2") {
      socket.destroy();
      if (opts.mode === "auto") return null;
      throw new RequestError(
        `${url.host} did not negotiate HTTP/2 (ALPN: ${alpn || "none"}). Use Auto to fall back to HTTP/1.1.`,
        "EH2NEGOTIATE",
      );
    }
  }

  return new Promise<SingleResponse>((resolve, reject) => {
    let settled = false;
    const session = http2.connect(url.origin, { createConnection: () => socket });

    const timer = setTimeout(() => {
      fail(new RequestError(`Request timed out after ${opts.timeoutMs} ms`, "ETIMEDOUT"));
    }, opts.timeoutMs);

    const onAbort = () => fail(new RequestError("Request was cancelled", "ECANCELLED"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // destroy() also tears down the socket, so nothing outlives the exchange.
      if (!session.destroyed) session.destroy();
      if (!socket.destroyed) socket.destroy();
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err instanceof RequestError || err instanceof HostPolicyError) return reject(err);
      const code = (err as NodeJS.ErrnoException).code ?? "EREQUEST";
      reject(new RequestError(err.message || code, code));
    }

    session.on("error", fail);
    // A GOAWAY or close before the response completes is a failure, not an empty success.
    session.on("close", () => fail(new RequestError(`Connection closed by ${url.host}`, "ECONNRESET")));

    if (opts.signal?.aborted) return onAbort();

    const req = session.request({
      ...toH2Headers(headers, url.host),
      ":method": method,
      ":path": `${url.pathname}${url.search}`,
      ":scheme": isHttps ? "https" : "http",
    });

    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    let status = 0;
    let responseHeaders: [string, string][] = [];
    let trailers: [string, string][] | undefined;

    const rawToPairs = (raw: string[]): [string, string][] => {
      const pairs: [string, string][] = [];
      for (let i = 0; i < raw.length; i += 2) {
        if (!raw[i].startsWith(":")) pairs.push([raw[i], raw[i + 1]]);
      }
      return pairs;
    };

    req.on("response", (h, _flags, raw) => {
      firstByteAt = performance.now();
      status = Number(h[":status"]) || 0;
      responseHeaders = rawToPairs(raw as unknown as string[]);
    });
    req.on("trailers", (_h, _flags, raw) => {
      trailers = rawToPairs(raw as unknown as string[]);
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      const end = performance.now();
      const remoteAddress = socket.remoteAddress;
      cleanup();
      const connectBase = tcpAt || dnsAt;
      resolve({
        status,
        statusText: "",
        httpVersion: "2",
        rawHeaders: responseHeaders,
        trailers,
        body: Buffer.concat(chunks),
        truncated,
        remoteAddress,
        timings: {
          dns: round(dnsAt - start),
          tcp: round(tcpAt ? tcpAt - dnsAt : 0),
          tls: round(tlsAt ? tlsAt - connectBase : 0),
          ttfb: round(firstByteAt - (tlsAt || tcpAt || dnsAt)),
          download: round(end - firstByteAt),
        },
      });
    };

    req.on("data", (chunk: Buffer) => {
      if (received + chunk.length > opts.maxBodyBytes) {
        truncated = true;
        const remaining = opts.maxBodyBytes - received;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        received = opts.maxBodyBytes;
        req.close(http2.constants.NGHTTP2_CANCEL);
        finish();
        return;
      }
      received += chunk.length;
      chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", fail);

    if (body && body.length) req.end(body);
    else req.end();
  });

  function connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code ?? "EREQUEST";
        if (err instanceof HostPolicyError) return reject(err);
        reject(new RequestError(err.message || code, code));
      };
      const sock = isHttps
        ? tls.connect({
            host: hostname,
            port,
            lookup,
            ALPNProtocols: ["h2", "http/1.1"],
            servername: net.isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: opts.verifySsl,
          })
        : net.connect({ host: hostname, port, lookup });
      let done = false;
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbortConnect);
        fn();
      };
      const timer = setTimeout(() => {
        sock.destroy();
        settle(() => reject(new RequestError(`Request timed out after ${opts.timeoutMs} ms`, "ETIMEDOUT")));
      }, opts.timeoutMs);
      const onAbortConnect = () => {
        sock.destroy();
        settle(() => reject(new RequestError("Request was cancelled", "ECANCELLED")));
      };
      opts.signal?.addEventListener("abort", onAbortConnect, { once: true });
      if (opts.signal?.aborted) return onAbortConnect();
      sock.on("connect", () => (tcpAt = performance.now()));
      sock.once("error", (err) => {
        sock.destroy();
        settle(() => onError(err));
      });
      sock.once(isHttps ? "secureConnect" : "connect", () => {
        tlsAt = isHttps ? performance.now() : 0;
        sock.removeAllListeners("error");
        settle(() => resolve(sock));
      });
    });
  }
}
