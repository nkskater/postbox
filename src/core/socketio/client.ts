/**
 * Socket.IO (v3/v4 servers, Engine.IO 4) client for the server-side relay.
 * WebSocket transport only; the connection's DNS lookups go through the host
 * policy via a custom agent, and every event in either direction is reported.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { io, type Socket } from "socket.io-client";
import type { PreparedRequest, SocketIoSettings } from "../types";
import { HostPolicyError, OPEN_POLICY, type HostPolicy } from "../http/policy";

export type SocketIoEvent =
  | { type: "open"; id: string; namespace: string; at: number }
  | { type: "event"; direction: "in" | "out"; event: string; args: unknown[]; at: number }
  | { type: "ack"; event: string; args: unknown[]; at: number }
  | { type: "ack-timeout"; event: string; timeoutMs: number; at: number }
  | { type: "error"; error: string; at: number }
  | { type: "close"; reason: string; at: number };

export interface SocketIoConnection {
  emit(event: string, args: unknown[], ack?: boolean): void;
  close(): void;
  readonly connected: boolean;
}

/** Event names Socket.IO reserves on the client. */
const RESERVED = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

export function normalizeNamespace(ns: string | undefined): string {
  const trimmed = (ns ?? "").trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function connectSocketIo(
  prepared: PreparedRequest,
  cfg: SocketIoSettings,
  onEvent: (e: SocketIoEvent) => void,
  opts: { policy?: HostPolicy; signal?: AbortSignal } = {},
): SocketIoConnection {
  const policy = opts.policy ?? OPEN_POLICY;
  const url = new URL(prepared.url);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Socket.IO URLs must start with http:// or https://");
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
  const agent =
    url.protocol === "https:"
      ? new https.Agent({ lookup, rejectUnauthorized: prepared.settings.verifySsl } as https.AgentOptions)
      : new http.Agent({ lookup } as http.AgentOptions);
  const headers: Record<string, string> = {};
  for (const [k, v] of prepared.headers)
    if (!/^(host|connection|upgrade|content-length)$/i.test(k)) headers[k] = v;
  const namespace = normalizeNamespace(cfg.namespace);
  const listeners = new Set((cfg.listeners ?? []).map((l) => l.trim()).filter(Boolean));
  const ackTimeoutMs = cfg.ackTimeoutMs ?? 5000;
  const now = () => Date.now();

  const socket: Socket = io(`${url.origin}${namespace === "/" ? "" : namespace}${url.search}`, {
    path: cfg.path?.trim() || "/socket.io",
    transports: ["websocket"],
    extraHeaders: headers,
    agent: agent as unknown as string,
    rejectUnauthorized: prepared.settings.verifySsl,
    reconnection: false,
    timeout: prepared.settings.timeoutMs,
    forceNew: true,
    ...(cfg.auth ? { auth: cfg.auth } : {}),
  });
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    opts.signal?.removeEventListener("abort", onAbort);
    agent.destroy();
    onEvent({ type: "close", reason, at: now() });
  };
  socket.on("connect", () => onEvent({ type: "open", id: socket.id ?? "", namespace, at: now() }));
  socket.on("connect_error", (err) => {
    onEvent({ type: "error", error: err.message, at: now() });
    socket.close();
    close("Connection failed");
  });
  socket.on("disconnect", (reason) => close(reason));
  socket.onAny((event: string, ...args: unknown[]) => {
    if (listeners.size === 0 || listeners.has(event))
      onEvent({ type: "event", direction: "in", event, args, at: now() });
  });
  const onAbort = () => {
    close("Closed by client");
    socket.close();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    get connected() {
      return socket.connected;
    },
    emit(event: string, args: unknown[], ack = false) {
      if (!socket.connected) throw new Error("Socket.IO is not connected");
      if (!event.trim() || RESERVED.has(event))
        throw new Error(`"${event}" is not an event name you can emit`);
      onEvent({ type: "event", direction: "out", event, args, at: now() });
      if (!ack) return void socket.emit(event, ...args);
      socket.timeout(ackTimeoutMs).emit(event, ...args, (err: Error | null, ...response: unknown[]) => {
        if (err) onEvent({ type: "ack-timeout", event, timeoutMs: ackTimeoutMs, at: now() });
        else onEvent({ type: "ack", event, args: response, at: now() });
      });
    },
    close() {
      close("Closed by client");
      socket.close();
    },
  };
}
