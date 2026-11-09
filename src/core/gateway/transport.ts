import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { HostPolicyError, type HostPolicy } from "../http/policy";
import { planConnection } from "../http/outbound";
import { safeResponseHeaders } from "../broker/inject";
import { GatewayRedactor } from "./redactor";

export class GatewayTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export interface GatewayCompletion {
  status: number | null;
  outcome: "success" | "error" | "cancelled" | "limited";
  code: string;
  bytes: number;
  durationMs: number;
}
export interface GatewayTransportOptions {
  url: string;
  method: string;
  headers: [string, string][];
  body: Buffer;
  policy: HostPolicy;
  secrets: string[];
  timeoutMs: number;
  maxResponseBytes: number;
  allowStreaming: boolean;
  signal?: AbortSignal;
  onComplete: (result: GatewayCompletion) => void;
  onHeaders?: (status: number, headers: [string, string][]) => void;
}

/** One fixed upstream destination: DNS policy, proxy/TLS settings, bounded backpressure and no redirects. */
export function openGatewayStream(
  opts: GatewayTransportOptions,
): Promise<{ status: number; headers: [string, string][]; body: ReadableStream<Uint8Array> | null }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let status: number | null = null,
      bytes = 0,
      wireBytes = 0,
      completed = false,
      resolved = false;
    let incoming: http.IncomingMessage | undefined;
    let request: http.ClientRequest | undefined;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    let failure: GatewayTransportError | undefined;
    const finish = (outcome: GatewayCompletion["outcome"], code: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline.timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        opts.onComplete({ status, outcome, code, bytes, durationMs: Date.now() - started });
      } catch {
        /* A trace write must not break stream teardown. */
      }
    };
    const stop = (error: GatewayTransportError, outcome: GatewayCompletion["outcome"] = "error") => {
      failure = error;
      if (!resolved) status = error.status;
      request?.destroy(error);
      incoming?.destroy(error);
      finish(outcome, error.code);
      if (!resolved) reject(error);
    };
    const onAbort = () =>
      stop(new GatewayTransportError("cancelled", "Gateway request cancelled", 499), "cancelled");
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    deadline.timer = setTimeout(
      () => stop(new GatewayTransportError("timeout", "Gateway upstream deadline exceeded", 504)),
      opts.timeoutMs,
    );
    try {
      const url = new URL(opts.url);
      opts.policy.assertTarget(url.hostname, !!opts.policy.network?.proxyFor(url));
      const lookup: net.LookupFunction = (hostname, options, callback) => {
        dns.lookup(hostname, options, (error, address, family) => {
          if (error) return callback(error, address as string, family);
          const addresses = Array.isArray(address) ? address : [{ address, family }];
          for (const entry of addresses) {
            const reason = opts.policy.check(hostname, entry.address);
            if (reason) return callback(new HostPolicyError(reason), "", 4);
          }
          callback(null, address as string, family);
        });
      };
      const plan = planConnection(
        url,
        { policy: opts.policy, lookup, verifySsl: true, timeoutMs: opts.timeoutMs, signal: opts.signal },
        url.pathname + url.search,
      );
      const headers: string[] = ["Host", url.host, "Accept-Encoding", "identity"];
      for (const [name, value] of [...opts.headers, ...plan.headers])
        if (name.toLowerCase() !== "accept-encoding") headers.push(name, value);
      if (opts.body.length) headers.push("Content-Length", String(opts.body.length));
      request = (plan.secure ? https : http).request(
        {
          ...plan.options,
          protocol: plan.secure ? "https:" : "http:",
          path: plan.path,
          method: opts.method,
          headers,
          agent: false,
        },
        (response) => {
          incoming = response;
          response.on("error", () => {});
          status = response.statusCode ?? 502;
          if (status >= 300 && status < 400)
            return stop(new GatewayTransportError("redirect", "Upstream redirects are not allowed"));
          if (!opts.allowStreaming && /text\/event-stream/i.test(String(response.headers["content-type"])))
            return stop(
              new GatewayTransportError("streaming", "Upstream streaming is disabled by route policy", 403),
            );
          const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
          let source: Readable = response;
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "br"
                ? createBrotliDecompress()
                : encoding === "deflate"
                  ? createInflate()
                  : null;
          if (!decoder && encoding !== "identity")
            return stop(new GatewayTransportError("encoding", "Unsupported upstream content encoding"));
          if (decoder) {
            response.on("error", (error) => decoder.destroy(error));
            source = response.pipe(decoder);
            // Preserve backpressure; the decoder and web reader each have bounded buffers.
            decoder.on("error", () => incoming?.destroy());
          }
          if (decoder)
            response.on("data", (chunk: Buffer) => {
              wireBytes += chunk.length;
              if (wireBytes > opts.maxResponseBytes)
                stop(
                  new GatewayTransportError("response_size", "Gateway response size limit exceeded"),
                  "limited",
                );
            });
          const rawHeaders: [string, string][] = [];
          for (let index = 0; index < response.rawHeaders.length; index += 2)
            rawHeaders.push([response.rawHeaders[index], response.rawHeaders[index + 1]]);
          const allowed = new Set([
            "content-type",
            "mcp-session-id",
            "mcp-protocol-version",
            "retry-after",
            "x-request-id",
          ]);
          const responseHeaders = safeResponseHeaders(
            rawHeaders.filter(([name]) => allowed.has(name.toLowerCase())),
            opts.secrets,
          );
          try {
            opts.onHeaders?.(status, responseHeaders);
          } catch (error) {
            return stop(
              error instanceof GatewayTransportError
                ? error
                : new GatewayTransportError("upstream_headers", "Upstream response headers were rejected"),
            );
          }
          const iterator = source[Symbol.asyncIterator]();
          const redactor = new GatewayRedactor(opts.secrets);
          if (opts.method === "HEAD" || status === 204 || status === 304) {
            response.resume();
            response.once("end", () =>
              finish(
                (status ?? 0) >= 400 ? "error" : "success",
                (status ?? 0) >= 400 ? "upstream_status" : "ok",
              ),
            );
            resolved = true;
            return resolve({ status, headers: responseHeaders, body: null });
          }
          const body = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  for (;;) {
                    if (failure) throw failure;
                    const item = await iterator.next();
                    if (item.done) {
                      const tail = redactor.feed(Buffer.alloc(0), true);
                      if (tail.length) controller.enqueue(new Uint8Array(tail));
                      controller.close();
                      finish(
                        (status ?? 0) >= 400 ? "error" : "success",
                        (status ?? 0) >= 400 ? "upstream_status" : "ok",
                      );
                      return;
                    }
                    const chunk = Buffer.from(item.value);
                    bytes += chunk.length;
                    if (bytes > opts.maxResponseBytes) {
                      const error = new GatewayTransportError(
                        "response_size",
                        "Gateway response size limit exceeded",
                      );
                      stop(error, "limited");
                      throw error;
                    }
                    const safe = redactor.feed(chunk);
                    if (safe.length) {
                      controller.enqueue(new Uint8Array(safe));
                      return;
                    }
                  }
                } catch {
                  stop(failure ?? new GatewayTransportError("upstream", "Gateway upstream stream failed"));
                  controller.error(failure);
                }
              },
              cancel() {
                stop(new GatewayTransportError("cancelled", "Gateway response cancelled", 499), "cancelled");
              },
            },
            { highWaterMark: 1 },
          );
          resolved = true;
          resolve({ status, headers: responseHeaders, body });
        },
      );
      request.on("error", (error) =>
        stop(
          failure ??
            (error instanceof HostPolicyError
              ? new GatewayTransportError("network_policy", "Blocked by outbound network policy", 403)
              : new GatewayTransportError("upstream", "Gateway upstream connection failed")),
        ),
      );
      request.end(opts.body.length ? opts.body : undefined);
    } catch (error) {
      stop(
        error instanceof HostPolicyError
          ? new GatewayTransportError("network_policy", "Blocked by outbound network policy", 403)
          : new GatewayTransportError("upstream", "Gateway upstream connection failed"),
      );
    }
  });
}
