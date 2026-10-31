import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { connectWebSocket, type WsEvent } from "@/core/ws/client";
import { HostPolicy } from "@/core/http/policy";
import type { PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-ws-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const handshakes: http.IncomingHttpHeaders[] = [];
function echoServer(server: http.Server | https.Server) {
  const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has("chat") ? "chat" : false) });
  wss.on("headers", (_h, req) => handshakes.push(req.headers));
  wss.on("connection", (socket, req) => {
    if (req.url === "/bye") return socket.close(4001, "go away");
    socket.on("message", (data, binary) => {
      const text = data.toString();
      if (!binary && text === "close-me") return socket.close(4002, "asked");
      socket.send(data, { binary });
    });
  });
  return wss;
}

let base = "";
let tlsBase = "";
const plain = http.createServer((req, res) => {
  if (req.url === "/denied") return res.writeHead(401).end();
  res.writeHead(426).end();
});
const tls = https.createServer({
  cert: fs.readFileSync(path.join(__dirname, "fixtures/tls/localhost-cert.pem")),
  key: fs.readFileSync(path.join(__dirname, "fixtures/tls/localhost-key.pem")),
});
plain.on("upgrade", (req, socket) => {
  if (req.url === "/denied") {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  }
});
beforeAll(async () => {
  const wssPlain = echoServer(plain);
  // The ws server owns upgrades except /denied, which the raw handler refuses first.
  plain.removeAllListeners("upgrade");
  plain.on("upgrade", (req, socket, head) => {
    if (req.url === "/denied") return socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    wssPlain.handleUpgrade(req, socket, head, (ws) => wssPlain.emit("connection", ws, req));
  });
  echoServer(tls);
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(plain.address() as AddressInfo).port}`;
  tlsBase = `wss://localhost:${(tls.address() as AddressInfo).port}`;
});
afterAll(async () => {
  plain.close();
  tls.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (url: string, headers: [string, string][] = [], verifySsl = true): PreparedRequest => ({
  method: "GET",
  url,
  headers,
  settings: { ...DEFAULT_SETTINGS, verifySsl },
});

function session(
  url: string,
  opts: Parameters<typeof connectWebSocket>[2] = {},
  headers: [string, string][] = [],
  verifySsl = true,
) {
  const events: WsEvent[] = [];
  let resolveOpen!: () => void;
  let resolveDone!: () => void;
  const opened = new Promise<void>((r) => (resolveOpen = r));
  const done = new Promise<void>((r) => (resolveDone = r));
  const waiters: (() => void)[] = [];
  const conn = connectWebSocket(
    req(url, headers, verifySsl),
    (e) => {
      events.push(e);
      if (e.type === "open") resolveOpen();
      if (e.type === "close") resolveDone();
      waiters.splice(0).forEach((w) => w());
    },
    opts,
  );
  const next = (pred: (e: WsEvent) => boolean) =>
    new Promise<WsEvent>((resolve) => {
      const check = () => {
        const hit = events.find(pred);
        if (hit) resolve(hit);
        else waiters.push(check);
      };
      check();
    });
  return { conn, events, opened, done, next };
}

describe("WebSocket client", () => {
  it("connects with headers and a subprotocol, echoes text and binary, and closes normally", async () => {
    const s = session(base + "/echo", { protocols: ["chat"] }, [
      ["Authorization", "Bearer ws-token"],
      ["Sec-WebSocket-Key", "ignored"],
    ]);
    await s.opened;
    expect(s.events[0]).toMatchObject({ type: "open", protocol: "chat" });
    expect(handshakes.at(-1)!.authorization).toBe("Bearer ws-token");
    s.conn.send("hello");
    expect(await s.next((e) => e.type === "message" && e.direction === "in" && !e.binary)).toMatchObject({
      data: "hello",
      size: 5,
    });
    s.conn.send(Buffer.from([1, 2, 3]).toString("base64"), true);
    expect(await s.next((e) => e.type === "message" && e.direction === "in" && e.binary)).toMatchObject({
      data: "AQID",
      size: 3,
    });
    expect(s.events.filter((e) => e.type === "message" && e.direction === "out")).toHaveLength(2);
    s.conn.close();
    await s.done;
    expect(s.events.at(-1)).toMatchObject({ type: "close", code: 1000 });
  });

  it("reports server-initiated closes and refused upgrades", async () => {
    const bye = session(base + "/bye");
    await bye.done;
    expect(bye.events.at(-1)).toMatchObject({ type: "close", code: 4001, reason: "go away" });
    const denied = session(base + "/denied");
    await denied.done;
    expect(denied.events.some((e) => e.type === "error" && /HTTP 401/.test(e.error))).toBe(true);
  });

  it("enforces the host policy, message limits and cancellation", async () => {
    expect(() => session(base + "/echo", { policy: new HostPolicy([], ["127.0.0.1"]) })).toThrow(
      /PROXY_DENY_HOSTS/,
    );
    expect(() => session("http://127.0.0.1/echo")).toThrow(/ws:\/\/ or wss:\/\//);
    const s = session(base + "/echo", { maxMessageBytes: 4 });
    await s.opened;
    expect(() => s.conn.send("too long")).toThrow(/limited to 4 bytes/);
    const ctrl = new AbortController();
    const c = session(base + "/echo", { signal: ctrl.signal });
    await c.opened;
    ctrl.abort();
    await c.done;
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 1000 });
    s.conn.close();
  });

  it("connects over TLS and honours certificate verification", async () => {
    const strict = session(tlsBase + "/echo");
    await strict.done;
    expect(strict.events.some((e) => e.type === "error" && /certificate/i.test(e.error))).toBe(true);
    const relaxed = session(tlsBase + "/echo", {}, [], false);
    await relaxed.opened;
    relaxed.conn.send("secure");
    expect(await relaxed.next((e) => e.type === "message" && e.direction === "in")).toMatchObject({
      data: "secure",
    });
    relaxed.conn.close();
  });
});

describe("WebSocket relay API", () => {
  it("opens a session, sends through it, redacts secrets and closes", async () => {
    const repo = await import("@/server/repo");
    const open = await import("@/app/api/ws/route");
    const send = await import("@/app/api/ws/[id]/send/route");
    const close = await import("@/app/api/ws/[id]/close/route");
    const sessions = await import("@/server/ws-sessions");
    const ws = repo.createWorkspace("WS");
    const folder = repo.createFolder(ws.id, null, {
      name: "c",
      auth: { type: "bearer", bearer: { token: "{{t}}" } },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "t", value: "relay-secret", type: "secret", enabled: true },
      { key: "host", value: base, type: "default", enabled: true },
    ]);
    const res = await open.POST(
      new Request("http://localhost/api/ws", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws.id, folderId: folder.id, request: { url: "{{host}}/echo" } }),
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const lines: Record<string, unknown>[] = [];
    const nextLine = async (pred: (l: Record<string, unknown>) => boolean) => {
      for (;;) {
        const hit = lines.find(pred);
        if (hit) return hit;
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
        const parts = buffer.split("\n");
        buffer = parts.pop()!;
        for (const p of parts) if (p) lines.push(JSON.parse(p));
      }
    };
    const id = (await nextLine((l) => l.type === "session")).id as string;
    await nextLine((l) => l.type === "open");
    expect(handshakes.at(-1)!.authorization).toBe("Bearer relay-secret");
    const post = (route: typeof send, body: object, sid = id) =>
      route.POST(
        new Request(`http://localhost/api/ws/${sid}/${route === send ? "send" : "close"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: sid }) },
      );
    expect((await post(send, { data: "token is relay-secret" })).status).toBe(200);
    const echoed = await nextLine((l) => l.type === "message" && l.direction === "in");
    expect(echoed.data).toBe("token is ********");
    expect((await post(send, { data: "x" }, "unknown")).status).toBe(404);
    sessions.getOwnedSession(id, "open")!.owner = "user:someone-else";
    expect((await post(send, { data: "x" })).status).toBe(404);
    sessions.getOwnedSession(id, "user:someone-else")!.owner = "open";
    expect((await post(close, {})).status).toBe(200);
    expect(await nextLine((l) => l.type === "done")).toMatchObject({ code: 1000 });
    expect(sessions.sessionCount()).toBe(0);
    (await import("@/server/db")).getSqlite().close();
  });
});
