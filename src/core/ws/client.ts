/**
 * WebSocket client used by the server-side session relay. Connections go through
 * the outbound host policy (including DNS results), carry the request's resolved
 * headers and auth, and report every frame with a timestamp.
 */
import dns from "node:dns";
import net from "node:net";
import WebSocket from "ws";
import type { PreparedRequest } from "../types";
import { HostPolicyError, OPEN_POLICY, type HostPolicy } from "../http/policy";

export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

export type WsEvent =
  | { type: "open"; protocol: string; headers: [string, string][]; at: number }
  | { type: "message"; direction: "in" | "out"; data: string; binary: boolean; size: number; at: number }
  | { type: "close"; code: number; reason: string; at: number }
  | { type: "error"; error: string; at: number };

export interface WsConnection {
  send(data: string, binary?: boolean): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface WsConnectOptions {
  policy?: HostPolicy;
  protocols?: string[];
  signal?: AbortSignal;
  maxMessageBytes?: number;
}

/** Hop-by-hop and handshake headers the ws library sets itself. */
const RESERVED = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "transfer-encoding",
]);

export function connectWebSocket(
  prepared: PreparedRequest,
  onEvent: (e: WsEvent) => void,
  opts: WsConnectOptions = {},
): WsConnection {
  const policy = opts.policy ?? OPEN_POLICY;
  const maxBytes = opts.maxMessageBytes ?? MAX_WS_MESSAGE_BYTES;
  const url = new URL(prepared.url);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error(`WebSocket URLs must start with ws:// or wss:// (got ${url.protocol})`);
  policy.assert(url.hostname);

  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return cb(err, address as string, family);
      const addrs = Array.isArray(address) ? address : [{ address, family }];
      for (const a of addrs) {
        const reason = policy.check(hostname, a.address);
        if (reason) return cb(new HostPolicyError(reason), "", 4);
      }
      cb(null, address as string, family);
    });
  };
  const headers: Record<string, string> = {};
  for (const [k, v] of prepared.headers) if (!RESERVED.has(k.toLowerCase())) headers[k] = v;

  const ws = new WebSocket(url, opts.protocols?.length ? opts.protocols : undefined, {
    headers,
    lookup,
    rejectUnauthorized: prepared.settings.verifySsl,
    handshakeTimeout: prepared.settings.timeoutMs,
    maxPayload: maxBytes,
    followRedirects: false,
    perMessageDeflate: false,
  });
  let closed = false;
  const now = () => Date.now();

  ws.on("upgrade", (res) => {
    const raw: [string, string][] = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
    ws.once("open", () => onEvent({ type: "open", protocol: ws.protocol, headers: raw, at: now() }));
  });
  ws.on("message", (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    onEvent({
      type: "message",
      direction: "in",
      data: isBinary ? buf.toString("base64") : buf.toString("utf8"),
      binary: isBinary,
      size: buf.length,
      at: now(),
    });
  });
  ws.on("unexpected-response", (_req, res) => {
    onEvent({
      type: "error",
      error: `Server refused the WebSocket upgrade (HTTP ${res.statusCode})`,
      at: now(),
    });
    res.resume();
    ws.terminate();
  });
  ws.on("error", (err) => onEvent({ type: "error", error: err.message, at: now() }));
  ws.on("close", (code, reason) => {
    if (closed) return;
    closed = true;
    opts.signal?.removeEventListener("abort", onAbort);
    onEvent({ type: "close", code, reason: reason.toString("utf8"), at: now() });
  });
  const onAbort = () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Closed by client");
    else ws.terminate();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  return {
    get readyState() {
      return ws.readyState;
    },
    send(data: string, binary = false) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("The WebSocket is not open");
      const payload = binary ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
      if (payload.length > maxBytes) throw new Error(`Messages are limited to ${maxBytes} bytes`);
      ws.send(payload, { binary });
      onEvent({ type: "message", direction: "out", data, binary, size: payload.length, at: now() });
    },
    close(code = 1000, reason = "") {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
        else ws.terminate();
      }
    },
  };
}
