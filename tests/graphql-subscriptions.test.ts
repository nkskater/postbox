import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  subscribeOverSse,
  subscribeOverWebSocket,
  toWebSocketUrl,
  type SubscriptionEvent,
} from "@/core/graphql/subscribe";
import type { PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-gqlsub-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const seen: { init?: unknown; subscribe?: unknown; auth?: string; pong?: boolean; completed?: boolean }[] =
  [];
let base = "";
const server = http.createServer((req, res) => {
  // graphql-sse distinct connections mode
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(body || "{}");
    if (!query) return res.writeHead(400).end();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      n++;
      res.write(
        `event: next\ndata: ${JSON.stringify({ data: { tick: n, room: variables?.room, auth: req.headers.authorization } })}\n\n`,
      );
      if (n === 3) {
        clearInterval(timer);
        res.end("event: complete\ndata:\n\n");
      }
    }, 10);
  });
});
const wss = new WebSocketServer({
  server,
  handleProtocols: (p) => (p.has("graphql-transport-ws") ? "graphql-transport-ws" : false),
});
wss.on("connection", (socket, req) => {
  const record: (typeof seen)[number] = { auth: req.headers.authorization };
  seen.push(record);
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "connection_init") {
      record.init = msg.payload;
      if (req.url === "/silent") return;
      socket.send(JSON.stringify({ type: "connection_ack" }));
      socket.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong") record.pong = true;
    else if (msg.type === "subscribe") {
      record.subscribe = msg.payload;
      if (req.url === "/forever") {
        const t = setInterval(
          () => socket.send(JSON.stringify({ id: msg.id, type: "next", payload: { data: { x: 1 } } })),
          5,
        );
        socket.on("close", () => clearInterval(t));
        return;
      }
      if (req.url === "/fail")
        return socket.send(
          JSON.stringify({ id: msg.id, type: "error", payload: [{ message: "bad field" }] }),
        );
      for (let i = 1; i <= 2; i++)
        socket.send(JSON.stringify({ id: msg.id, type: "next", payload: { data: { n: i } } }));
      socket.send(JSON.stringify({ id: msg.id, type: "complete" }));
    } else if (msg.type === "complete") record.completed = true;
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  wss.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (p: string, headers: [string, string][] = []): PreparedRequest => ({
  method: "POST",
  url: base + p,
  headers,
  body: Buffer.from(JSON.stringify({ query: "subscription { n }", variables: { room: "r1" } })),
  settings: DEFAULT_SETTINGS,
});
async function collect(
  run: typeof subscribeOverWebSocket,
  p: string,
  opts: Parameters<typeof run>[2] = {},
  headers: [string, string][] = [],
) {
  const events: SubscriptionEvent[] = [];
  await run(req(p, headers), (e) => events.push(e), opts);
  return events;
}

describe("graphql-transport-ws", () => {
  it("converts http URLs to ws", () => {
    expect(toWebSocketUrl("https://api.example/graphql")).toBe("wss://api.example/graphql");
    expect(toWebSocketUrl("http://h/g")).toBe("ws://h/g");
    expect(toWebSocketUrl("ws://h/g")).toBe("ws://h/g");
  });

  it("initialises, subscribes, answers pings and completes", async () => {
    const events = await collect(subscribeOverWebSocket, "/graphql", { connectionParams: { token: "t1" } }, [
      ["Authorization", "Bearer abc"],
    ]);
    expect(events.map((e) => e.type)).toEqual(["open", "next", "next", "done"]);
    expect(events.filter((e) => e.type === "next").map((e) => (e as { payload: unknown }).payload)).toEqual([
      { data: { n: 1 } },
      { data: { n: 2 } },
    ]);
    expect(events.at(-1)).toMatchObject({ reason: "Subscription completed" });
    expect(seen.at(-1)).toMatchObject({
      auth: "Bearer abc",
      init: { token: "t1" },
      subscribe: { query: "subscription { n }", variables: { room: "r1" } },
      pong: true,
    });
  });

  it("reports errors, ack timeouts, the message limit and cancellation", async () => {
    const failed = await collect(subscribeOverWebSocket, "/fail", { maxMessages: 5 });
    expect(failed.find((e) => e.type === "error")).toMatchObject({ errors: [{ message: "bad field" }] });
    expect(failed.at(-1)).toMatchObject({ reason: "Subscription failed" });

    expect((await collect(subscribeOverWebSocket, "/silent", { ackTimeoutMs: 50 })).at(-1)).toMatchObject({
      reason: "No connection_ack from the server",
    });
    const limited = await collect(subscribeOverWebSocket, "/forever", { maxMessages: 3 });
    expect(limited.filter((e) => e.type === "next")).toHaveLength(3);
    expect(limited.at(-1)).toMatchObject({ reason: "Stopped after 3 messages" });

    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const cancelled = await collect(subscribeOverWebSocket, "/forever", {
      signal: stop.signal,
      maxMessages: 100000,
    });
    expect(cancelled.at(-1)).toMatchObject({ reason: "Cancelled" });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.at(-1)!.completed).toBe(true);
  });
});

describe("graphql-sse", () => {
  it("streams next events until complete", async () => {
    const events = await collect(subscribeOverSse, "/graphql", {}, [["Authorization", "Bearer sse"]]);
    expect(events.map((e) => e.type)).toEqual(["open", "next", "next", "next", "done"]);
    expect((events[1] as { payload: unknown }).payload).toEqual({
      data: { tick: 1, room: "r1", auth: "Bearer sse" },
    });
    expect(events.at(-1)).toMatchObject({ reason: "Subscription completed" });
  });

  it("stops at the message limit", async () => {
    const events = await collect(subscribeOverSse, "/graphql", { maxMessages: 2 });
    expect(events.filter((e) => e.type === "next")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ reason: "Stopped after 2 messages" });
  });
});

describe("POST /api/graphql/subscribe", () => {
  it("relays messages with variables resolved in params and secrets redacted", async () => {
    const repo = await import("@/server/repo");
    const { POST } = await import("@/app/api/graphql/subscribe/route");
    const ws = repo.createWorkspace("Subscriptions");
    const folder = repo.createFolder(ws.id, null, { name: "c" });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "host", value: base, type: "default", enabled: true },
      { key: "token", value: "sub-secret", type: "secret", enabled: true },
    ]);
    const call = async (transport: "ws" | "sse") => {
      const res = await POST(
        new Request("http://localhost/api/graphql/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: ws.id,
            folderId: folder.id,
            transport,
            connectionParams: '{"token": "{{token}}"}',
            request: {
              url: "{{host}}/graphql",
              headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }],
              body: {
                mode: "graphql",
                graphql: { query: "subscription { n }", variables: '{"room": "r1"}' },
              },
            },
          }),
        }),
      );
      return (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    };
    const wsLines = await call("ws");
    expect(wsLines.map((l) => l.type)).toEqual(["open", "next", "next", "done"]);
    expect(seen.at(-1)).toMatchObject({ init: { token: "sub-secret" } });
    const sseLines = await call("sse");
    expect(sseLines[1].payload.data.auth).toBe("Bearer ********");
    expect(JSON.stringify([...wsLines, ...sseLines])).not.toContain("sub-secret");
    (await import("@/server/db")).getSqlite().close();
  });
});
