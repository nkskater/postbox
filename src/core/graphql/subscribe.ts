/**
 * GraphQL subscriptions over the graphql-transport-ws protocol (WebSocket) and
 * the graphql-sse protocol (distinct connections mode). Both take a prepared
 * POST request whose body is the resolved `{ query, variables, operationName }`.
 */
import type { PreparedRequest } from "../types";
import type { HostPolicy } from "../http/policy";
import { connectWebSocket } from "../ws/client";
import { streamEvents } from "../http/sse";

export type SubscriptionEvent =
  | { type: "open"; transport: "ws" | "sse"; at: number }
  | { type: "next"; payload: unknown; at: number }
  | { type: "error"; errors: unknown; at: number }
  | { type: "done"; reason: string; at: number };

export interface SubscribeOptions {
  policy?: HostPolicy;
  signal?: AbortSignal;
  /** graphql-transport-ws connection_init payload. */
  connectionParams?: Record<string, unknown>;
  /** Stop after this many `next` messages. */
  maxMessages?: number;
  /** Time allowed for connection_ack. */
  ackTimeoutMs?: number;
}

/** The WebSocket endpoint for an HTTP GraphQL URL (http→ws, https→wss). */
export function toWebSocketUrl(url: string): string {
  return url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

function payloadOf(prepared: PreparedRequest): Record<string, unknown> {
  try {
    return JSON.parse(prepared.body?.toString("utf8") ?? "{}") as Record<string, unknown>;
  } catch {
    throw new Error("GraphQL subscription body is not valid JSON");
  }
}

export function subscribeOverWebSocket(
  prepared: PreparedRequest,
  onEvent: (e: SubscriptionEvent) => void,
  opts: SubscribeOptions = {},
): Promise<void> {
  const payload = payloadOf(prepared);
  const max = opts.maxMessages ?? 1000;
  return new Promise((resolve, reject) => {
    let count = 0;
    let finished = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(ackTimer);
      onEvent({ type: "done", reason, at: Date.now() });
      resolve();
    };
    let conn: ReturnType<typeof connectWebSocket>;
    // Frames can still arrive while the socket closes; replies to them are dropped, not thrown.
    const send = (msg: object) => {
      if (conn.readyState === 1) conn.send(JSON.stringify(msg));
    };
    try {
      conn = connectWebSocket(
        { ...prepared, url: toWebSocketUrl(prepared.url), method: "GET", body: undefined },
        (e) => {
          if (finished) return;
          if (e.type === "open") {
            if (e.protocol !== "graphql-transport-ws") {
              conn.close(4406, "Subprotocol not acceptable");
              return finish("Server did not accept the graphql-transport-ws subprotocol");
            }
            onEvent({ type: "open", transport: "ws", at: e.at });
            send({
              type: "connection_init",
              ...(opts.connectionParams ? { payload: opts.connectionParams } : {}),
            });
            ackTimer = setTimeout(() => {
              conn.close(4408, "Connection initialisation timeout");
              finish("No connection_ack from the server");
            }, opts.ackTimeoutMs ?? 10_000);
          } else if (e.type === "message" && e.direction === "in" && !e.binary) {
            let msg: { type?: string; id?: string; payload?: unknown };
            try {
              msg = JSON.parse(e.data);
            } catch {
              return onEvent({ type: "error", errors: `Invalid message: ${e.data.slice(0, 200)}`, at: e.at });
            }
            if (msg.type === "connection_ack") {
              clearTimeout(ackTimer);
              send({ id: "1", type: "subscribe", payload });
            } else if (msg.type === "ping") send({ type: "pong" });
            else if (msg.type === "next") {
              onEvent({ type: "next", payload: msg.payload, at: e.at });
              if (++count >= max) {
                send({ id: "1", type: "complete" });
                conn.close(1000, "Message limit reached");
                finish(`Stopped after ${max} messages`);
              }
            } else if (msg.type === "error") {
              // An error message terminates the operation in graphql-transport-ws.
              onEvent({ type: "error", errors: msg.payload, at: e.at });
              conn.close(1000, "Operation failed");
              finish("Subscription failed");
            } else if (msg.type === "complete") {
              conn.close(1000, "Complete");
              finish("Subscription completed");
            }
          } else if (e.type === "error") onEvent({ type: "error", errors: e.error, at: e.at });
          else if (e.type === "close")
            finish(`Connection closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
        },
        // Abort is handled below so `complete` is sent before the socket closes.
        { policy: opts.policy, protocols: ["graphql-transport-ws"] },
      );
    } catch (err) {
      return reject(err);
    }
    const onAbort = () => {
      try {
        send({ id: "1", type: "complete" });
      } catch {
        // Not yet subscribed.
      }
      conn.close(1000, "Cancelled");
      finish("Cancelled");
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function subscribeOverSse(
  prepared: PreparedRequest,
  onEvent: (e: SubscriptionEvent) => void,
  opts: SubscribeOptions = {},
): Promise<void> {
  payloadOf(prepared);
  let done = false;
  const ctrl = new AbortController();
  opts.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const max = opts.maxMessages ?? 1000;
  let count = 0;
  await streamEvents(
    {
      ...prepared,
      method: "POST",
      headers: [
        ...prepared.headers.filter(([k]) => !/^(accept|content-type)$/i.test(k)),
        ["Content-Type", "application/json"],
        ["Accept", "text/event-stream"],
      ],
    },
    (m) => {
      if (m.type === "open") {
        if (m.status === 200) onEvent({ type: "open", transport: "sse", at: Date.now() });
      } else if (m.type === "event") {
        if (m.event === "complete") {
          done = true;
          ctrl.abort();
          return;
        }
        let payload: unknown = m.data;
        try {
          payload = JSON.parse(m.data);
        } catch {
          // Keep raw text.
        }
        onEvent({ type: "next", payload, at: m.receivedAt });
        if (++count >= max) ctrl.abort();
      } else if (m.type === "closed") {
        const reason = done
          ? "Subscription completed"
          : count >= max
            ? `Stopped after ${max} messages`
            : opts.signal?.aborted
              ? "Cancelled"
              : m.reason;
        onEvent({ type: "done", reason, at: Date.now() });
      }
    },
    { policy: opts.policy, signal: ctrl.signal, maxReconnects: 0, maxEvents: max + 1 },
  );
}
