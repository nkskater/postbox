import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Aedes } from "aedes";
import { connectMqtt, validTopicFilter, type MqttConnection, type MqttEvent } from "@/core/mqtt/client";
import { HostPolicy } from "@/core/http/policy";
import type { MqttSettings, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mqtt-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let broker: Aedes;
let server: net.Server;
let base = "";
const logins: { username?: string; clientId: string }[] = [];
beforeAll(async () => {
  broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      logins.push({ username, clientId: client.id });
      if (username === "denied")
        return done(Object.assign(new Error("bad credentials"), { returnCode: 4 }), false);
      done(null, true);
    },
  });
  server = net.createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => broker.close(() => r()));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (url = base): PreparedRequest => ({
  method: "CONNECT",
  url,
  headers: [],
  settings: DEFAULT_SETTINGS,
});
async function open(cfg: MqttSettings = {}, creds = {}, opts: Parameters<typeof connectMqtt>[4] = {}) {
  const events: MqttEvent[] = [];
  const waiters: (() => void)[] = [];
  const conn: MqttConnection = await connectMqtt(
    req(),
    cfg,
    creds,
    (e) => {
      events.push(e);
      waiters.splice(0).forEach((w) => w());
    },
    opts,
  );
  const next = (pred: (e: MqttEvent) => boolean) =>
    new Promise<MqttEvent>((resolve) => {
      const check = () => {
        const hit = events.find(pred);
        if (hit) resolve(hit);
        else waiters.push(check);
      };
      check();
    });
  return { conn, events, next };
}

describe("MQTT client", () => {
  it("validates topic filters", () => {
    expect(validTopicFilter("a/+/c")).toBe(true);
    expect(validTopicFilter("a/#")).toBe(true);
    expect(validTopicFilter("a/#/c")).toBe(false);
    expect(validTopicFilter("a/b+")).toBe(false);
    expect(validTopicFilter("")).toBe(false);
  });

  it("connects with credentials, restores saved subscriptions and receives published messages", async () => {
    const sub = await open(
      { clientId: "sub-1", subscriptions: [{ topic: "sensors/+/temp", qos: 1 }] },
      { username: "alice", password: "pw" },
    );
    expect(await sub.next((e) => e.type === "open")).toMatchObject({ clientId: "sub-1" });
    expect(logins.at(-1)).toEqual({ username: "alice", clientId: "sub-1" });
    expect(await sub.next((e) => e.type === "subscribed")).toMatchObject({
      topic: "sensors/+/temp",
      granted: 1,
    });
    const pub = await open();
    await pub.next((e) => e.type === "open");
    await pub.conn.publish("sensors/kitchen/temp", "21.5", { qos: 1 });
    expect(await sub.next((e) => e.type === "message")).toMatchObject({
      topic: "sensors/kitchen/temp",
      payload: "21.5",
      binary: false,
      qos: 1,
    });
    await pub.conn.publish("sensors/garage/temp", Buffer.from([0, 1, 255]).toString("base64"), {
      binary: true,
    });
    expect(await sub.next((e) => e.type === "message" && e.binary)).toMatchObject({
      payload: "AAH/",
      size: 3,
    });
    sub.conn.close();
    pub.conn.close();
    expect(await sub.next((e) => e.type === "close")).toMatchObject({ reason: "Closed by client" });
  });

  it("delivers retained messages to later subscribers and supports unsubscribe", async () => {
    const pub = await open();
    await pub.next((e) => e.type === "open");
    await pub.conn.publish("state/door", "open", { retain: true, qos: 1 });
    const late = await open();
    await late.next((e) => e.type === "open");
    await late.conn.subscribe("state/door", 1);
    expect(await late.next((e) => e.type === "message")).toMatchObject({ payload: "open", retain: true });
    await late.conn.unsubscribe("state/door");
    expect(late.events.some((e) => e.type === "unsubscribed")).toBe(true);
    await expect(late.conn.subscribe("a/#/b")).rejects.toThrow(/Invalid topic filter/);
    await expect(pub.conn.publish("x/+", "y")).rejects.toThrow(/wildcards/);
    pub.conn.close();
    late.conn.close();
  });

  it("surfaces a broker's refusal of MQTT 5 (the local test broker only speaks 3.1.1)", async () => {
    const v5 = await open({ protocolVersion: 5 });
    expect(await v5.next((e) => e.type === "error")).toMatchObject({ error: expect.stringMatching(/protocol version/i) });
  });

  it("reports refused credentials, blocks denied hosts and rejects other schemes", async () => {
    const denied = await open({}, { username: "denied", password: "x" });
    expect(await denied.next((e) => e.type === "close")).toMatchObject({ reason: "Connection failed" });
    expect(denied.events.some((e) => e.type === "error")).toBe(true);
    await expect(open({}, {}, { policy: new HostPolicy([], ["127.0.0.1"]) })).rejects.toThrow(
      /PROXY_DENY_HOSTS/,
    );
    await expect(connectMqtt(req("http://127.0.0.1/"), {}, {}, () => undefined)).rejects.toThrow(/mqtt:\/\//);
  });
});

describe("MQTT relay API", () => {
  it("connects with Basic auth, publishes and subscribes through the session, and redacts the password", async () => {
    const repo = await import("@/server/repo");
    const openRoute = await import("@/app/api/mqtt/route");
    const publish = await import("@/app/api/mqtt/[id]/publish/route");
    const subscribe = await import("@/app/api/mqtt/[id]/subscribe/route");
    const close = await import("@/app/api/mqtt/[id]/close/route");
    const sessions = await import("@/server/ws-sessions");
    const ws = repo.createWorkspace("MQTT");
    const folder = repo.createFolder(ws.id, null, {
      name: "c",
      auth: { type: "basic", basic: { username: "relay", password: "{{pw}}" } },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "pw", value: "mqtt-secret", type: "secret", enabled: true },
      { key: "broker", value: base, type: "default", enabled: true },
    ]);
    const res = await openRoute.POST(
      new Request("http://localhost/api/mqtt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws.id, folderId: folder.id, request: { url: "{{broker}}" } }),
      }),
    );
    expect(res.status).toBe(200);
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
    expect(logins.at(-1)!.username).toBe("relay");
    const post = (route: { POST: typeof publish.POST }, kind: string, body: object, sid = id) =>
      route.POST(
        new Request(`http://localhost/api/mqtt/${sid}/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: sid }) },
      );
    expect((await post(subscribe, "subscribe", { topic: "relay/#" })).status).toBe(200);
    await nextLine((l) => l.type === "subscribed");
    expect((await post(publish, "publish", { topic: "relay/a", payload: "pw is mqtt-secret" })).status).toBe(
      200,
    );
    const msg = await nextLine((l) => l.type === "message");
    expect(msg.payload).toBe("pw is ********");
    expect((await post(publish, "publish", { topic: "x" }, "unknown")).status).toBe(404);
    expect(sessions.getOwnedSession(id, "open", "ws")).toBeUndefined();
    expect((await post(close as unknown as { POST: typeof publish.POST }, "close", {})).status).toBe(200);
    await nextLine((l) => l.type === "done");
    expect(sessions.sessionCount()).toBe(0);
    expect(JSON.stringify(lines)).not.toContain("mqtt-secret");
    (await import("@/server/db")).getSqlite().close();
  });
});
