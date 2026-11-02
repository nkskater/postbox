import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { createOutboundAgent } from "../http/outbound";
import { HostPolicyError, type HostPolicy } from "../http/policy";
/** A streaming Fetch adapter with DNS/IP policy checks and the shared proxy/TLS configuration. */
export function mcpFetch(
  origin: string,
  policy: HostPolicy,
  timeoutMs: number,
  lifetime: AbortSignal,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("MCP transport URL must stay on its configured HTTP(S) origin");
    policy.assertTarget(url.hostname, !!policy.network?.proxyFor(url));
    const headers = new Headers(init.headers);
    for (const name of [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "upgrade",
      "proxy-authorization",
    ])
      headers.delete(name);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string")
      throw new Error("MCP accepts JSON request bodies only");
    if (typeof init.body === "string" && Buffer.byteLength(init.body) > 1048576)
      throw new Error("MCP request exceeds 1 MiB");
    const signal = AbortSignal.any([lifetime, ...(init.signal ? [init.signal] : [])]);
    const lookup: net.LookupFunction = (hostname, options, callback) =>
      dns.lookup(hostname, options, (error, address, family) => {
        if (error) return callback(error, address as string, family);
        const addresses = Array.isArray(address) ? address : [{ address, family }];
        for (const a of addresses) {
          const reason = policy.check(hostname, a.address);
          if (reason) return callback(new HostPolicyError(reason), "", 4);
        }
        callback(null, address as string, family);
      });
    const agent = createOutboundAgent(url, { policy, lookup, verifySsl: true, timeoutMs, signal });
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        { method: init.method ?? "GET", headers: Object.fromEntries(headers), agent, signal },
        (response) => {
          const status = response.statusCode ?? 500;
          const outHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            outHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          let bytes = 0,
            ended = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on("data", (chunk) => {
                if (ended) return;
                bytes += chunk.length;
                if (bytes > 2 * 1048576) {
                  ended = true;
                  controller.error(new Error("MCP response exceeds 2 MiB"));
                  request.destroy();
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
              });
              response.once("end", () => {
                if (!ended) {
                  ended = true;
                  controller.close();
                }
              });
              response.once("error", (error) => {
                if (!ended) {
                  ended = true;
                  controller.error(error);
                }
              });
            },
            cancel() {
              ended = true;
              request.destroy();
            },
          });
          settled = true;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : stream, { status, headers: outHeaders }),
          );
        },
      );
      const timer = setTimeout(() => request.destroy(new Error("MCP transport timed out")), timeoutMs);
      timer.unref?.();
      request.once("error", (error) => {
        if (!settled) reject(error);
      });
      request.once("close", () => {
        clearTimeout(timer);
        agent.destroy();
      });
      if (init.body) request.write(init.body);
      request.end();
    });
  }) as typeof fetch;
}
