/**
 * Server-sent events (WHATWG HTML "event stream" format): an incremental parser
 * that tolerates arbitrary chunk boundaries, and a client that streams events,
 * honours `retry`, and reconnects with Last-Event-ID until cancelled.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { PreparedRequest } from "../types";
import { HostPolicyError, OPEN_POLICY, type HostPolicy } from "./policy";
import { isProxyError, planConnection, tlsOptions } from "./outbound";

export interface SseEvent {
  /** "message" unless the stream set an event name. */
  event: string;
  data: string;
  /** The last event ID in effect when this event was dispatched. */
  id: string;
}

/** Incremental parser; feed decoded text as it arrives. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private eventName = "";
  private sawBom = false;
  private pendingCr = false;
  lastEventId = "";
  retry: number | undefined;

  constructor(private onEvent: (e: SseEvent) => void) {}

  feed(text: string) {
    if (!this.sawBom) {
      if (!text) return;
      this.sawBom = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    // A CR at the end of the previous chunk may be the first half of CRLF.
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = false;
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      this.line(this.buffer.slice(start, i));
      if (c === "\r") {
        if (i + 1 === this.buffer.length) this.pendingCr = true;
        else if (this.buffer[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  private line(line: string) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
  }

  private dispatch() {
    const hadData = this.data.length > 0;
    const event = { event: this.eventName || "message", data: this.data.join("\n"), id: this.lastEventId };
    this.data = [];
    this.eventName = "";
    if (hadData) this.onEvent(event);
  }
}

export type SseMessage =
  | { type: "open"; status: number; headers: [string, string][]; attempt: number }
  | ({ type: "event"; index: number; receivedAt: number } & SseEvent)
  | { type: "reconnecting"; delayMs: number; lastEventId: string; reason: string }
  | { type: "closed"; reason: string; events: number };

export interface SseOptions {
  policy?: HostPolicy;
  signal?: AbortSignal;
  /** Stop after this many events (bounded retention for the caller). */
  maxEvents?: number;
  /** Automatic reconnects after the stream ends or fails; 0 disables. */
  maxReconnects?: number;
  /** Initial reconnection delay until the server sends `retry:`. */
  retryMs?: number;
}

const MAX_RETRY_MS = 60_000;

/** Open the stream and report events until it is cancelled, exhausted or refused. */
export async function streamEvents(
  prepared: PreparedRequest,
  onMessage: (m: SseMessage) => void,
  opts: SseOptions = {},
): Promise<void> {
  const policy = opts.policy ?? OPEN_POLICY;
  const maxEvents = opts.maxEvents ?? 1000;
  const maxReconnects = opts.maxReconnects ?? 3;
  let retryMs = opts.retryMs ?? 3000;
  let lastEventId = "";
  let index = 0;
  const close = (reason: string) => onMessage({ type: "closed", reason, events: index });

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) return close("Cancelled");
    let outcome: { ended: string; retryable: boolean };
    try {
      outcome = await openOnce(
        prepared,
        { ...opts, policy },
        lastEventId,
        attempt,
        onMessage,
        (parser, e) => {
          lastEventId = parser.lastEventId;
          if (parser.retry !== undefined) retryMs = Math.min(parser.retry, MAX_RETRY_MS);
          onMessage({ type: "event", index: index++, receivedAt: Date.now(), ...e });
          return index >= maxEvents;
        },
      );
    } catch (err) {
      outcome = { ended: (err as Error).message, retryable: !(err instanceof HostPolicyError) };
    }
    if (opts.signal?.aborted) return close("Cancelled");
    if (index >= maxEvents) return close(`Stopped after ${maxEvents} events`);
    if (!outcome.retryable || attempt >= maxReconnects) return close(outcome.ended);
    onMessage({ type: "reconnecting", delayMs: retryMs, lastEventId, reason: outcome.ended });
    const waited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), retryMs);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        { once: true },
      );
    });
    if (!waited) return close("Cancelled");
  }
}

function openOnce(
  prepared: PreparedRequest,
  opts: SseOptions & { policy: HostPolicy },
  lastEventId: string,
  attempt: number,
  onMessage: (m: SseMessage) => void,
  onEvent: (parser: SseParser, e: SseEvent) => boolean,
): Promise<{ ended: string; retryable: boolean }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(prepared.url);
    } catch {
      return reject(new Error(`Invalid URL: ${prepared.url}`));
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return reject(new HostPolicyError(`Unsupported protocol "${url.protocol}"`));
    const socketPath = prepared.settings.socketPath;
    try {
      if (socketPath) opts.policy.assertSocket(socketPath);
      else opts.policy.assertTarget(url.hostname, !!opts.policy.network?.proxyFor(url));
    } catch (err) {
      return reject(err);
    }
    const lookup: net.LookupFunction = (hostname, options, cb) => {
      dns.lookup(hostname, options, (err, address, family) => {
        if (err) return cb(err, address as string, family);
        const addrs = Array.isArray(address) ? address : [{ address, family }];
        for (const a of addrs) {
          const reason = opts.policy.check(hostname, a.address);
          if (reason) return cb(new HostPolicyError(reason), "", 4);
        }
        cb(null, address as string, family);
      });
    };
    const headers: string[] = [];
    const has = (n: string) => prepared.headers.some(([k]) => k.toLowerCase() === n);
    if (!has("host")) headers.push("Host", url.host);
    for (const [k, v] of prepared.headers) if (k.toLowerCase() !== "last-event-id") headers.push(k, v);
    if (!has("accept")) headers.push("Accept", "text/event-stream");
    if (!has("cache-control")) headers.push("Cache-Control", "no-cache");
    if (lastEventId) headers.push("Last-Event-ID", lastEventId);
    else {
      const userId = prepared.headers.find(([k]) => k.toLowerCase() === "last-event-id");
      if (userId) headers.push("Last-Event-ID", userId[1]);
    }
    if (prepared.body?.length && !has("content-length"))
      headers.push("Content-Length", String(prepared.body.length));

    const isHttps = url.protocol === "https:";
    const plan = socketPath
      ? null
      : planConnection(
          url,
          {
            policy: opts.policy,
            lookup,
            verifySsl: prepared.settings.verifySsl,
            timeoutMs: prepared.settings.timeoutMs,
            signal: opts.signal,
          },
          `${url.pathname}${url.search}`,
        );
    if (plan) for (const [k, v] of plan.headers) headers.push(k, v);
    let settled = false;
    const finish = (ended: string, retryable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ended, retryable });
    };
    const req = (plan ? (plan.secure ? https : http) : isHttps ? https : http).request(
      {
        method: prepared.method,
        ...(plan
          ? { ...plan.options, path: plan.path, protocol: plan.secure ? "https:" : "http:" }
          : {
              protocol: url.protocol,
              socketPath,
              path: `${url.pathname}${url.search}`,
              rejectUnauthorized: prepared.settings.verifySsl,
              servername: net.isIP(url.hostname) ? undefined : url.hostname,
              ...tlsOptions(opts.policy.network?.tlsFor(url.hostname, Number(url.port) || 443)),
            }),
        headers: headers as unknown as http.OutgoingHttpHeaders,
        agent: plan?.options.createConnection ? undefined : false,
        setHost: false,
      },
      (res) => {
        const rawHeaders: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2)
          rawHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        onMessage({ type: "open", status, headers: rawHeaders, attempt });
        // Per the spec, only a 200 text/event-stream response is an event stream; anything else ends it.
        if (status !== 200 || !/^text\/event-stream/i.test(type)) {
          res.resume();
          return finish(
            status === 204
              ? "Server closed the stream (204)"
              : `Not an event stream (HTTP ${status}${type ? `, ${type.split(";")[0]}` : ""})`,
            false,
          );
        }
        clearTimeout(connectTimer);
        const decoder = new StringDecoder("utf8");
        const parser: SseParser = new SseParser((e) => {
          if (onEvent(parser, e)) {
            req.destroy();
            finish("Event limit reached", false);
          }
        });
        res.on("data", (chunk: Buffer) => parser.feed(decoder.write(chunk)));
        res.on("end", () => {
          parser.feed(decoder.end());
          finish("Server ended the stream", true);
        });
        res.on("error", (err) => finish(err.message, true));
        res.on("close", () => finish("Connection closed", true));
      },
    );
    const connectTimer = setTimeout(() => {
      req.destroy();
      finish(`No response after ${prepared.settings.timeoutMs} ms`, true);
    }, prepared.settings.timeoutMs);
    const onAbort = () => {
      clearTimeout(connectTimer);
      req.destroy();
      finish("Cancelled", false);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return onAbort();
    req.on("error", (err) => {
      clearTimeout(connectTimer);
      if (err instanceof HostPolicyError) {
        settled = true;
        return reject(err);
      }
      if (isProxyError(err)) {
        settled = true;
        return reject(new Error(err.message));
      }
      finish(err.message, true);
    });
    if (prepared.body?.length) req.write(prepared.body);
    req.end();
  });
}
