import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { connectSocketIo, normalizeNamespace, type SocketIoEvent } from "@/core/socketio/client";
import { HostPolicy } from "@/core/http/policy";
import type { PreparedRequest, SocketIoSettings } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sio-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const handshakes: { auth?: string; handshakeAuth?: unknown; ns: string }[] = [];
let base = "";
const httpServer = http.createServer();
const io = new Server(httpServer, { path: "/rt" });
for (const ns of ["/", "/chat"]) {
  io.of(ns).on("connection", (socket) => {
    handshakes.push({
      auth: socket.handshake.headers.authorization,
      handshakeAuth: socket.handshake.auth,
      ns,
    });
    socket.emit("welcome", { ns });
    socket.emit("noise", 1);
    socket.on("echo", (...args: unknown[]) => {
      const cb = typeof args.at(-1) === "function" ? (args.pop() as (...a: unknown[]) => void) : null;
      if (cb) cb({ ok: true, got: args });
      else socket.emit("echoed", ...args);
    });
    socket.on("ignore-ack", () => undefined);
    socket.on("kick", () => socket.disconnect(true));
  });
}
beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await io.close();
  httpServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (headers: [string, string][] = []): PreparedRequest => ({
  method: "GET",
  url: base + "/",
  headers,
  settings: DEFAULT_SETTINGS,
});
function connect(
  cfg: SocketIoSettings,
  opts: Parameters<typeof connectSocketIo>[3] = {},
  headers: [string, string][] = [],
) {
  const events: SocketIoEvent[] = [];
  const waiters: (() => void)[] = [];
  const conn = connectSocketIo(
    req(headers),
    cfg,
    (e) => {
      events.push(e);
      waiters.splice(0).forEach((w) => w());
    },
    opts,
  );
  const next = (pred: (e: SocketIoEvent) => boolean) =>
    new Promise<SocketIoEvent>((resolve) => {
      const check = () => {
        const hit = events.find(pred);
        if (hit) resolve(hit);
        else waiters.push(check);
      };
      check();
    });
  return { conn, events, next };
}

describe("Socket.IO client", () => {
  it("normalizes namespaces", () => {
    expect(normalizeNamespace(undefined)).toBe("/");
    expect(normalizeNamespace("chat")).toBe("/chat");
    expect(normalizeNamespace("/chat")).toBe("/chat");
  });

  it("connects to a namespace with headers and handshake auth, emits and receives events", async () => {
    const s = connect({ namespace: "chat", path: "/rt", auth: { token: "hs" } }, {}, [
      ["Authorization", "Bearer sio"],
    ]);
    expect(await s.next((e) => e.type === "open")).toMatchObject({ namespace: "/chat" });
    expect(handshakes.at(-1)).toEqual({ auth: "Bearer sio", handshakeAuth: { token: "hs" }, ns: "/chat" });
    expect(await s.next((e) => e.type === "event" && e.event === "welcome")).toMatchObject({
      args: [{ ns: "/chat" }],
    });
    s.conn.emit("echo", ["a", { b: 1 }]);
    expect(await s.next((e) => e.type === "event" && e.event === "echoed")).toMatchObject({
      direction: "in",
      args: ["a", { b: 1 }],
    });
    expect(s.events.some((e) => e.type === "event" && e.direction === "out" && e.event === "echo")).toBe(
      true,
    );
    s.conn.close();
    expect(await s.next((e) => e.type === "close")).toMatchObject({ reason: "Closed by client" });
  });

  it("reports acknowledgements and ack timeouts", async () => {
    const s = connect({ path: "/rt", ackTimeoutMs: 100 });
    await s.next((e) => e.type === "open");
    s.conn.emit("echo", [42], true);
    expect(await s.next((e) => e.type === "ack")).toMatchObject({
      event: "echo",
      args: [{ ok: true, got: [42] }],
    });
    s.conn.emit("ignore-ack", [], true);
    expect(await s.next((e) => e.type === "ack-timeout")).toMatchObject({
      event: "ignore-ack",
      timeoutMs: 100,
    });
    expect(() => s.conn.emit("connect", [])).toThrow(/not an event name/);
    s.conn.close();
  });

  it("filters incoming events by saved listeners and reports server disconnects", async () => {
    const s = connect({ path: "/rt", listeners: ["welcome"] });
    await s.next((e) => e.type === "event" && e.event === "welcome");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.events.some((e) => e.type === "event" && e.event === "noise")).toBe(false);
    s.conn.emit("kick", []);
    expect(await s.next((e) => e.type === "close")).toMatchObject({ reason: "io server disconnect" });
  });

  it("refuses blocked hosts and reports connection failures", async () => {
    expect(() => connect({ path: "/rt" }, { policy: new HostPolicy([], ["127.0.0.1"]) })).toThrow(
      /PROXY_DENY_HOSTS/,
    );
    const wrong = connect({ path: "/nope" });
    expect(await wrong.next((e) => e.type === "close")).toMatchObject({ reason: "Connection failed" });
    expect(wrong.events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("Socket.IO relay API", () => {
  it("connects, emits with ack, redacts secrets and isolates sessions", async () => {
    const repo = await import("@/server/repo");
    const open = await import("@/app/api/socketio/route");
    const emit = await import("@/app/api/socketio/[id]/emit/route");
    const close = await import("@/app/api/socketio/[id]/close/route");
    const sessions = await import("@/server/ws-sessions");
    const ws = repo.createWorkspace("SIO");
    const folder = repo.createFolder(ws.id, null, {
      name: "c",
      auth: { type: "bearer", bearer: { token: "{{t}}" } },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "t", value: "sio-secret", type: "secret", enabled: true },
      { key: "host", value: base, type: "default", enabled: true },
    ]);
    const res = await open.POST(
      new Request("http://localhost/api/socketio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws.id,
          folderId: folder.id,
          request: { url: "{{host}}/", settings: { socketio: { path: "/rt", namespace: "/chat" } } },
        }),
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
    expect(handshakes.at(-1)!.auth).toBe("Bearer sio-secret");
    const post = (route: typeof emit, kind: string, body: object, sid = id) =>
      route.POST(
        new Request(`http://localhost/api/socketio/${sid}/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: sid }) },
      );
    expect((await post(emit, "emit", { event: "echo", args: ["key sio-secret"], ack: true })).status).toBe(
      200,
    );
    const acked = await nextLine((l) => l.type === "ack");
    expect(JSON.stringify(acked)).toContain("key ********");
    expect((await post(emit, "emit", { event: "echo" }, "nope")).status).toBe(404);
    expect(sessions.getOwnedSession(id, "open", "ws")).toBeUndefined();
    expect((await post(close as unknown as typeof emit, "close", {})).status).toBe(200);
    await nextLine((l) => l.type === "done");
    expect(sessions.sessionCount()).toBe(0);
    expect(JSON.stringify(lines)).not.toContain("sio-secret");
    (await import("@/server/db")).getSqlite().close();
  });
});
