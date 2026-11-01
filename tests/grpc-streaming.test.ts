import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { startGrpcCall, type GrpcCallInput, type GrpcEvent } from "@/core/grpc/client";
import { decodeMessage, loadProtoRoot } from "@/core/grpc/proto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-grpc-stream-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const PROTO = `
syntax = "proto3";
package test;
service Chat {
  rpc Unary(Msg) returns (Msg);
  rpc Bidi(stream Msg) returns (stream Msg);
  rpc Sum(stream Msg) returns (Msg);
  rpc Hold(stream Msg) returns (stream Msg);
}
message Msg { string text = 1; int64 n = 2; }
`;
const root = loadProtoRoot({ "chat.proto": PROTO });
const Msg = root.lookupType("test.Msg");
const enc = (o: object) => Buffer.from(Msg.encode(Msg.fromObject(o)).finish());
const dec = (b: Buffer) => decodeMessage(Msg, b) as { text: string; n: string };

const id = (b: Buffer) => b;
const method = (p: string, requestStream: boolean, responseStream: boolean) => ({
  path: p,
  requestStream,
  responseStream,
  requestSerialize: id,
  requestDeserialize: id,
  responseSerialize: id,
  responseDeserialize: id,
});
const definition = {
  Unary: method("/test.Chat/Unary", false, false),
  Bidi: method("/test.Chat/Bidi", true, true),
  Sum: method("/test.Chat/Sum", true, false),
  Hold: method("/test.Chat/Hold", true, true),
} as unknown as grpc.ServiceDefinition;
const implementation = {
  Unary: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) =>
    cb(null, enc({ text: `re ${dec(call.request).text}` })),
  Bidi: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
    call.on("data", (b: Buffer) => call.write(enc({ text: `re ${dec(b).text}` })));
    call.on("end", () => call.end());
  },
  Sum: (call: grpc.ServerReadableStream<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    let sum = 0;
    call.on("data", (b: Buffer) => (sum += Number(dec(b).n)));
    call.on("end", () => cb(null, enc({ text: "sum", n: sum })));
  },
  // Never finishes by itself: used for cancellation and deadlines.
  Hold: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
    call.on("data", () => undefined);
  },
};

let server: grpc.Server;
let url: string;
beforeAll(async () => {
  server = new grpc.Server();
  server.addService(definition, implementation as unknown as grpc.UntypedServiceImplementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  url = `grpc://127.0.0.1:${port}`;
});
afterAll(() => {
  server.forceShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(methodName: string, extra: Partial<GrpcCallInput> = {}) {
  const events: GrpcEvent[] = [];
  const waiters: (() => void)[] = [];
  const started = startGrpcCall(
    {
      url,
      root,
      service: "test.Chat",
      method: methodName,
      messages: [],
      metadata: [],
      verifySsl: true,
      timeoutMs: 5000,
      interactive: true,
      ...extra,
    },
    (e) => {
      events.push(e);
      waiters.splice(0).forEach((w) => w());
    },
  );
  const next = <T extends GrpcEvent["type"]>(
    type: T,
    pred: (e: Extract<GrpcEvent, { type: T }>) => boolean = () => true,
  ) =>
    new Promise<Extract<GrpcEvent, { type: T }>>((resolve) => {
      const check = () => {
        const hit = events.find(
          (e): e is Extract<GrpcEvent, { type: T }> => e.type === type && pred(e as never),
        );
        if (hit) resolve(hit);
        else waiters.push(check);
      };
      check();
    });
  return { started, events, next };
}
const texts = (events: GrpcEvent[]) =>
  events.filter((e) => e.type === "message").map((e) => (e as { message: { text: string } }).message.text);

describe("interactive gRPC calls", () => {
  it("interleaves sends and responses on a bidirectional call", async () => {
    const { started, events, next } = open("Bidi");
    const { connection, finished } = await started;
    connection.send({ text: "a" });
    // The reply arrives while the request stream is still open.
    await next("message", (e) => (e.message as { text: string }).text === "re a");
    expect(events.some((e) => e.type === "status")).toBe(false);
    connection.send({ text: "b" });
    connection.end();
    await finished;
    expect(texts(events)).toEqual(["re a", "re b"]);
    expect(events.filter((e) => e.type === "sent").map((e) => (e as { index: number }).index)).toEqual([
      0, 1,
    ]);
    expect(events.find((e) => e.type === "status")).toMatchObject({ codeName: "OK" });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("sends initial messages, then more, on a client stream", async () => {
    const { started, events } = open("Sum", { messages: [{ n: 1 }] });
    const { connection, finished } = await started;
    connection.send({ n: 2 });
    connection.send({ n: 39 });
    connection.end();
    connection.end(); // idempotent
    await finished;
    expect(events.find((e) => e.type === "message")).toMatchObject({ message: { n: "42" } });
  });

  it("rejects sends after the stream is ended or the call finished, and invalid messages", async () => {
    const { started } = open("Sum");
    const { connection, finished } = await started;
    expect(() => connection.send({ n: "nope" })).toThrow(/must be a int64/);
    connection.send({ n: 5 }); // still usable after a rejected message
    connection.end();
    expect(() => connection.send({ n: 1 })).toThrow(/closed/);
    await finished;
    expect(() => connection.send({ n: 1 })).toThrow(/finished/);
    expect(() => connection.cancel()).not.toThrow();
  });

  it("cancels in flight", async () => {
    const { started, events, next } = open("Hold");
    const { connection, finished } = await started;
    connection.send({ text: "x" });
    await next("open");
    connection.cancel();
    await finished;
    expect(events.find((e) => e.type === "status")).toMatchObject({ codeName: "CANCELLED" });
  });

  it("applies the deadline to the open call", async () => {
    const { started, events } = open("Hold", { timeoutMs: 250 });
    await (
      await started
    ).finished;
    expect(events.find((e) => e.type === "status")).toMatchObject({ codeName: "DEADLINE_EXCEEDED" });
  });

  it("only allows interactive mode for methods that stream from the client", async () => {
    await expect(open("Unary").started).rejects.toThrow(/cannot be interactive/);
  });

  it("replays messages sent before the call connected when falling back to another address", async () => {
    const port = url.split(":").at(-1);
    const lookup = vi.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    try {
      const { started, events } = open("Bidi", {
        url: `grpc://dual.test:${port}`,
        messages: [{ text: "x" }],
      });
      const { connection, finished } = await started;
      connection.send({ text: "y" }); // sent while the first address is still being tried
      connection.end();
      await finished;
      expect(texts(events)).toEqual(["re x", "re y"]);
      expect(events.filter((e) => e.type === "sent")).toHaveLength(2);
      expect(events.filter((e) => e.type === "status")).toHaveLength(1);
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("interactive gRPC API", () => {
  type Handler = (...args: never[]) => Promise<Response>;
  const post = (route: { POST: Handler }, url: string, body: object, sid?: string) =>
    (route.POST as unknown as (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      sid ? { params: Promise.resolve({ id: sid }) } : undefined,
    );

  async function reader(res: Response) {
    const r = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const lines: Record<string, unknown>[] = [];
    const next = async (pred: (l: Record<string, unknown>) => boolean) => {
      for (;;) {
        const hit = lines.find(pred);
        if (hit) return hit;
        const { value, done } = await r.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
        const parts = buffer.split("\n");
        buffer = parts.pop()!;
        for (const p of parts) if (p) lines.push(JSON.parse(p));
      }
    };
    return { next, lines };
  }

  it("opens a session, sends, ends and cleans up", async () => {
    const repo = await import("@/server/repo");
    const open = await import("@/app/api/grpc/route");
    const send = await import("@/app/api/grpc/[id]/send/route");
    const end = await import("@/app/api/grpc/[id]/end/route");
    const cancel = await import("@/app/api/grpc/[id]/cancel/route");
    const sessions = await import("@/server/ws-sessions");
    const ws = repo.createWorkspace("grpc stream");
    const request = (m: string) => ({
      url,
      settings: { grpc: { protos: { "chat.proto": PROTO }, service: "test.Chat", method: m } },
    });

    const res = await post(open, "http://localhost/api/grpc", {
      workspaceId: ws.id,
      interactive: true,
      request: request("Bidi"),
    });
    expect(res.status).toBe(200);
    const stream = await reader(res);
    const sid = (await stream.next((l) => l.type === "session")).id as string;
    expect(sessions.sessionCount()).toBeGreaterThan(0);

    const url2 = `http://localhost/api/grpc/${sid}`;
    expect((await post(send, `${url2}/send`, { message: { text: "hi" } }, sid)).status).toBe(200);
    await stream.next((l) => l.type === "message" && (l.message as { text: string }).text === "re hi");
    const bad = await post(send, `${url2}/send`, { message: { nope: 1 } }, sid);
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Unknown field/);
    expect((await post(end, `${url2}/end`, {}, sid)).status).toBe(200);
    await stream.next((l) => l.type === "done");
    expect(sessions.getOwnedSession(sid, "anyone")).toBeUndefined();
    // The session is gone once the call is done.
    expect((await post(send, `${url2}/send`, { message: { text: "late" } }, sid)).status).toBe(404);
    expect((await post(cancel, `${url2}/cancel`, {}, "missing")).status).toBe(404);
  });

  it("cancels through the session and rejects non-streaming methods", async () => {
    const repo = await import("@/server/repo");
    const open = await import("@/app/api/grpc/route");
    const cancel = await import("@/app/api/grpc/[id]/cancel/route");
    const ws = repo.createWorkspace("grpc stream cancel");
    const request = (m: string) => ({
      url,
      settings: { grpc: { protos: { "chat.proto": PROTO }, service: "test.Chat", method: m } },
    });
    const res = await post(open, "http://localhost/api/grpc", {
      workspaceId: ws.id,
      interactive: true,
      request: request("Hold"),
    });
    const stream = await reader(res);
    const sid = (await stream.next((l) => l.type === "session")).id as string;
    expect((await post(cancel, `http://localhost/api/grpc/${sid}/cancel`, {}, sid)).status).toBe(200);
    expect(await stream.next((l) => l.type === "status")).toMatchObject({ codeName: "CANCELLED" });
    await stream.next((l) => l.type === "done");

    const unary = await post(open, "http://localhost/api/grpc", {
      workspaceId: ws.id,
      interactive: true,
      request: request("Unary"),
    });
    expect(unary.status).toBe(400);
    expect(((await unary.json()) as { error: string }).error).toMatch(/cannot be interactive/);
  });

  it('opens a session for interactive "auto" only on client-streaming methods', async () => {
    const repo = await import("@/server/repo");
    const open = await import("@/app/api/grpc/route");
    const cancel = await import("@/app/api/grpc/[id]/cancel/route");
    const ws = repo.createWorkspace("grpc auto");
    const request = (m: string, raw = "") => ({
      url,
      body: { mode: "raw", raw, language: "json" },
      settings: { grpc: { protos: { "chat.proto": PROTO }, service: "test.Chat", method: m } },
    });
    const auto = await post(open, "http://localhost/api/grpc", {
      workspaceId: ws.id,
      interactive: "auto",
      request: request("Sum"),
    });
    const stream = await reader(auto);
    const id = (await stream.next((l) => l.type === "session")).id as string;
    expect((await post(cancel, `http://localhost/api/grpc/${id}/cancel`, {}, id)).status).toBe(200);
    await stream.next((l) => l.type === "done");

    const plain = await post(open, "http://localhost/api/grpc", {
      workspaceId: ws.id,
      interactive: "auto",
      request: request("Unary", '{"text":"p"}'),
    });
    expect(plain.status).toBe(200);
    const events = (await plain.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string });
    expect(events.some((e) => e.type === "session")).toBe(false);
    expect(events.at(-1)!.type).toBe("done");
  });
});
