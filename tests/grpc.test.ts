import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import {
  MAX_GRPC_RESPONSE_MESSAGES,
  buildMetadata,
  runGrpcCall,
  type GrpcCallInput,
  type GrpcEvent,
} from "@/core/grpc/client";
import { describeServices, decodeMessage, encodeMessage, loadProtoRoot } from "@/core/grpc/proto";
import { HostPolicy } from "@/core/http/policy";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-grpc-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const PROTO = `
syntax = "proto3";
package test;
import "google/protobuf/timestamp.proto";
service Echo {
  rpc Unary(Msg) returns (Msg);
  rpc ServerStream(Msg) returns (stream Msg);
  rpc ClientStream(stream Msg) returns (Msg);
  rpc Bidi(stream Msg) returns (stream Msg);
  rpc Fail(Msg) returns (Msg);
  rpc Slow(Msg) returns (Msg);
  rpc Meta(Msg) returns (Msg);
  rpc Flood(Msg) returns (stream Msg);
}
message Msg {
  string text = 1;
  int64 n = 2;
  bytes data = 3;
  google.protobuf.Timestamp at = 4;
}
`;

const root = loadProtoRoot({ "echo.proto": PROTO });
const Msg = root.lookupType("test.Msg");
const enc = (o: object) => Buffer.from(Msg.encode(Msg.fromObject(o)).finish());
const dec = (b: Buffer) => decodeMessage(Msg, b) as { text: string; n: string };

const keyPem = fs.readFileSync(new URL("./fixtures/tls/localhost-key.pem", import.meta.url));
const certPem = fs.readFileSync(new URL("./fixtures/tls/localhost-cert.pem", import.meta.url));

const seenMetadata: Record<string, string[]>[] = [];
let slowCalls = 0;

function definition(): grpc.ServiceDefinition {
  const id = (b: Buffer) => b;
  const method = (name: string, requestStream: boolean, responseStream: boolean) => [
    name,
    {
      path: `/test.Echo/${name}`,
      requestStream,
      responseStream,
      requestSerialize: id,
      requestDeserialize: id,
      responseSerialize: id,
      responseDeserialize: id,
    },
  ];
  return Object.fromEntries([
    method("Unary", false, false),
    method("ServerStream", false, true),
    method("ClientStream", true, false),
    method("Bidi", true, true),
    method("Fail", false, false),
    method("Slow", false, false),
    method("Meta", false, false),
    method("Flood", false, true),
  ]) as unknown as grpc.ServiceDefinition;
}

const handlers = {
  Unary: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    const m = dec(call.request);
    cb(null, enc({ text: `echo ${m.text}`, n: m.n }));
  },
  ServerStream: (call: grpc.ServerWritableStream<Buffer, Buffer>) => {
    const m = dec(call.request);
    for (let i = 0; i < Number(m.n); i++) call.write(enc({ text: m.text, n: i }));
    call.end();
  },
  ClientStream: (call: grpc.ServerReadableStream<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    let sum = 0;
    call.on("data", (b: Buffer) => (sum += Number(dec(b).n)));
    call.on("end", () => cb(null, enc({ text: "sum", n: sum })));
  },
  Bidi: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
    call.on("data", (b: Buffer) => call.write(enc({ text: `re ${dec(b).text}` })));
    call.on("end", () => call.end());
  },
  Fail: (_call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) =>
    cb({ code: grpc.status.NOT_FOUND, details: "no such thing" }),
  Slow: (_call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    slowCalls++;
    setTimeout(() => cb(null, enc({ text: "late" })), 5000).unref();
  },
  Meta: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    seenMetadata.push(call.metadata.getMap() as unknown as Record<string, string[]>);
    const trailers = new grpc.Metadata();
    trailers.set("x-checksum", "abc");
    cb(null, enc({ text: "meta" }), trailers);
  },
  Flood: (call: grpc.ServerWritableStream<Buffer, Buffer>) => {
    for (let i = 0; i < MAX_GRPC_RESPONSE_MESSAGES + 50; i++) call.write(enc({ n: i }));
    call.end();
  },
};

let plain: grpc.Server;
let secure: grpc.Server;
let plainUrl: string;
let secureUrl: string;

const bind = (server: grpc.Server, creds: grpc.ServerCredentials) =>
  new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", creds, (err, port) => (err ? reject(err) : resolve(port))),
  );

beforeAll(async () => {
  plain = new grpc.Server();
  plain.addService(definition(), handlers as unknown as grpc.UntypedServiceImplementation);
  plainUrl = `grpc://127.0.0.1:${await bind(plain, grpc.ServerCredentials.createInsecure())}`;
  secure = new grpc.Server();
  secure.addService(definition(), handlers as unknown as grpc.UntypedServiceImplementation);
  secureUrl = `grpcs://localhost:${await bind(secure, grpc.ServerCredentials.createSsl(null, [{ private_key: keyPem, cert_chain: certPem }]))}`;
});

afterAll(() => {
  plain.forceShutdown();
  secure.forceShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function input(method: string, messages: unknown[], extra: Partial<GrpcCallInput> = {}): GrpcCallInput {
  return {
    url: plainUrl,
    root,
    service: "test.Echo",
    method,
    messages,
    metadata: [],
    verifySsl: true,
    timeoutMs: 5000,
    ...extra,
  };
}

async function call(
  method: string,
  messages: unknown[],
  extra: Partial<GrpcCallInput> = {},
  opts: Parameters<typeof runGrpcCall>[2] = {},
) {
  const events: GrpcEvent[] = [];
  await runGrpcCall(input(method, messages, extra), (e) => events.push(e), opts);
  return events;
}
const of = <T extends GrpcEvent["type"]>(events: GrpcEvent[], type: T) =>
  events.filter((e): e is Extract<GrpcEvent, { type: T }> => e.type === type);

describe("proto definitions", () => {
  it("lists services and methods with streaming flags", () => {
    const [echo] = describeServices(root);
    expect(echo.fullName).toBe("test.Echo");
    const byName = Object.fromEntries(echo.methods.map((m) => [m.name, m]));
    expect(byName.Unary).toMatchObject({
      path: "/test.Echo/Unary",
      clientStreaming: false,
      serverStreaming: false,
    });
    expect(byName.ServerStream).toMatchObject({ clientStreaming: false, serverStreaming: true });
    expect(byName.ClientStream).toMatchObject({ clientStreaming: true, serverStreaming: false });
    expect(byName.Bidi).toMatchObject({ clientStreaming: true, serverStreaming: true });
    expect(byName.Unary.requestType).toBe("test.Msg");
  });

  it("resolves imports only from supplied files and well-known types", () => {
    const withImport = loadProtoRoot({
      "a.proto": 'syntax="proto3"; package a; import "b.proto"; message A { b.B b = 1; }',
      "b.proto": 'syntax="proto3"; package b; message B { string s = 1; }',
    });
    expect(withImport.lookupType("a.A")).toBeTruthy();
    expect(() =>
      loadProtoRoot({ "a.proto": 'syntax="proto3"; package a; import "/etc/passwd"; message A {}' }),
    ).toThrow(/import "\/etc\/passwd" was not provided/);
    expect(() => loadProtoRoot({ "a.proto": 'syntax="proto3"; message A { Missing m = 1; }' })).toThrow();
    expect(() => loadProtoRoot({})).toThrow(/at least one/);
    expect(() => loadProtoRoot({ "a.proto": "this is not proto" })).toThrow(/a\.proto/);
  });

  it("round-trips int64, bytes and well-known types as JSON", () => {
    const buf = encodeMessage(Msg, {
      text: "x",
      n: "9007199254740993",
      data: "aGk=",
      at: { seconds: "5", nanos: 7 },
    });
    expect(decodeMessage(Msg, buf)).toMatchObject({
      text: "x",
      n: "9007199254740993",
      data: "aGk=",
      at: { seconds: "5", nanos: 7 },
    });
    expect(() => encodeMessage(Msg, { n: "not a number" })).toThrow(/"n" must be a int64/);
    expect(() => encodeMessage(Msg, { txt: "typo" })).toThrow(/Unknown field "txt" in Msg/);
    expect(() => encodeMessage(Msg, { at: { sec: 1 } })).toThrow(/Unknown field "at.sec"/);
    expect(() => encodeMessage(Msg, { text: 5 })).toThrow(/"text" must be a string/);
    expect(() => encodeMessage(Msg, [])).toThrow(/JSON objects/);
  });
});

describe("gRPC calls", () => {
  it("makes a unary call", async () => {
    const events = await call("Unary", [{ text: "hi", n: "9007199254740993" }]);
    expect(events.map((e) => e.type)).toEqual(["open", "metadata", "message", "status", "done"]);
    expect(of(events, "message")[0].message).toMatchObject({ text: "echo hi", n: "9007199254740993" });
    expect(of(events, "status")[0]).toMatchObject({ code: 0, codeName: "OK" });
  });

  it("receives a server stream", async () => {
    const messages = of(await call("ServerStream", [{ text: "s", n: 4 }]), "message");
    expect(messages.map((m) => (m.message as { n: string }).n)).toEqual(["0", "1", "2", "3"]);
  });

  it("sends a client stream", async () => {
    const events = await call("ClientStream", [{ n: 1 }, { n: 2 }, { n: 39 }]);
    expect(of(events, "sent")).toHaveLength(3);
    expect(of(events, "message")[0].message).toMatchObject({ text: "sum", n: "42" });
  });

  it("exchanges messages on a bidirectional stream", async () => {
    const events = await call("Bidi", [{ text: "a" }, { text: "b" }]);
    expect(of(events, "message").map((m) => (m.message as { text: string }).text)).toEqual(["re a", "re b"]);
    expect(of(events, "status")[0].code).toBe(0);
  });

  it("sends metadata, drops HTTP-reserved headers and reports trailers", async () => {
    const events = await call("Meta", [{}], {
      metadata: [
        ["X-Trace", "t-1"],
        ["User-Agent", "should-not-be-sent"],
        ["Content-Type", "text/plain"],
        ["grpc-timeout", "1S"],
        ["blob-bin", Buffer.from("raw").toString("base64")],
      ],
    });
    const seen = seenMetadata.at(-1)!;
    expect(seen["x-trace"]).toBe("t-1");
    expect(JSON.stringify(seen)).not.toContain("text/plain");
    expect(String(seen["user-agent"])).not.toContain("should-not-be-sent");
    expect(Buffer.from(seen["blob-bin"] as unknown as Buffer).toString()).toBe("raw");
    expect(of(events, "status")[0].trailers).toContainEqual(["x-checksum", "abc"]);
    expect(() => buildMetadata([["bad key!", "v"]])).toThrow(/Invalid metadata/);
  });

  it("reports non-OK statuses", async () => {
    const status = of(await call("Fail", [{}]), "status")[0];
    expect(status).toMatchObject({ code: 5, codeName: "NOT_FOUND", details: "no such thing" });
  });

  it("reports connection failures as a status", async () => {
    const events = await call("Unary", [{}], { url: "grpc://127.0.0.1:1" });
    expect(of(events, "status")[0].codeName).toBe("UNAVAILABLE");
    expect(events.at(-1)!.type).toBe("done");
  });

  it("enforces the deadline", async () => {
    const started = Date.now();
    const status = of(await call("Slow", [{}], { timeoutMs: 250 }), "status")[0];
    expect(status.codeName).toBe("DEADLINE_EXCEEDED");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("cancels in flight and when already aborted", async () => {
    const controller = new AbortController();
    const before = slowCalls;
    const pending = call("Slow", [{}], {}, { signal: controller.signal });
    for (let i = 0; slowCalls === before && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(of(await pending, "status")[0].codeName).toBe("CANCELLED");
    const events = await call("Unary", [{}], {}, { signal: AbortSignal.abort() });
    expect(events.map((e) => e.type)).toEqual(["open", "done"]);
  });

  it("stops a response flood at the message limit", async () => {
    const events = await call("Flood", [{}]);
    expect(of(events, "message").length).toBe(MAX_GRPC_RESPONSE_MESSAGES);
    expect(of(events, "error")[0].error).toMatch(/limit exceeded/);
    expect(of(events, "status")[0].codeName).toBe("CANCELLED");
  });

  it("validates before connecting", async () => {
    await expect(call("Unary", [{}, {}])).rejects.toThrow(/exactly one/);
    await expect(call("Unary", [{ n: "x" }])).rejects.toThrow(/"n" must be a int64/);
    await expect(call("Nope", [{}])).rejects.toThrow(/not defined/);
    await expect(call("Unary", [{}], { service: "Missing" })).rejects.toThrow(/not defined/);
    await expect(call("Unary", [{}], { url: "http://127.0.0.1:1" })).rejects.toThrow(/grpc:\/\//);
  });

  it("applies the host policy to the resolved address", async () => {
    const deny = { policy: new HostPolicy([], ["127.0.0.0/8"]) };
    await expect(call("Unary", [{}], {}, deny)).rejects.toThrow(/PROXY_DENY_HOSTS|denied/);
    await expect(call("Unary", [{}], { url: secureUrl }, deny)).rejects.toThrow(/PROXY_DENY_HOSTS|denied/);
  });

  it("supports TLS and verifies certificates unless disabled", async () => {
    const ok = await call("Unary", [{ text: "tls" }], { url: secureUrl, verifySsl: false });
    expect(of(ok, "message")[0].message).toMatchObject({ text: "echo tls" });
    const rejected = await call("Unary", [{}], { url: secureUrl, verifySsl: true });
    expect(of(rejected, "status")[0].codeName).toBe("UNAVAILABLE");
  });
});

describe("gRPC API", () => {
  async function readEvents(res: Response) {
    const text = await res.text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as GrpcEvent);
  }

  it("describes services without network access", async () => {
    const repo = await import("@/server/repo");
    const describe = await import("@/app/api/grpc/describe/route");
    const ws = repo.createWorkspace("gRPC describe");
    const post = (protos: Record<string, string>) =>
      describe.POST(
        new Request("http://localhost/api/grpc/describe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: ws.id, protos }),
        }),
      );
    const ok = await post({ "echo.proto": PROTO });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { services: { fullName: string }[] }).services[0].fullName).toBe(
      "test.Echo",
    );
    const bad = await post({ "x.proto": 'syntax="proto3"; import "missing.proto";' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/missing\.proto/);
  });

  it("calls a method with variables, auth metadata and redaction", async () => {
    const repo = await import("@/server/repo");
    const route = await import("@/app/api/grpc/route");
    const ws = repo.createWorkspace("gRPC call");
    const folder = repo.createFolder(ws.id, null, {
      name: "c",
      auth: { type: "bearer", bearer: { token: "{{tok}}" } },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "tok", value: "super-secret-token", type: "secret", enabled: true },
      { key: "host", value: plainUrl, type: "default", enabled: true },
    ]);
    const post = (request: object, folderId: string | null = folder.id) =>
      route.POST(
        new Request("http://localhost/api/grpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: ws.id, folderId, request }),
        }),
      );
    const grpcSettings = (method: string) => ({
      grpc: { protos: { "echo.proto": PROTO }, service: "test.Echo", method },
    });

    const res = await post({
      url: "{{host}}",
      body: { mode: "raw", raw: '{"text": "{{tok}}"}', language: "json" },
      settings: grpcSettings("Meta"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readEvents(res);
    expect(seenMetadata.at(-1)!.authorization).toBe("Bearer super-secret-token");
    expect(events.at(-1)!.type).toBe("done");
    expect(JSON.stringify(events)).not.toContain("super-secret-token");

    const echoed = await readEvents(
      await post({
        url: "{{host}}",
        body: { mode: "raw", raw: '{"text": "{{tok}}"}', language: "json" },
        settings: grpcSettings("Unary"),
      }),
    );
    expect(JSON.stringify(echoed)).not.toContain("super-secret-token");
    expect(of(echoed, "message")[0].message).toMatchObject({ text: expect.stringContaining("echo") });

    const streamed = await readEvents(
      await post({
        url: "{{host}}",
        body: { mode: "raw", raw: '[{"n": 2}, {"n": 3}]', language: "json" },
        settings: grpcSettings("ClientStream"),
      }),
    );
    expect(of(streamed, "message")[0].message).toMatchObject({ n: "5" });
  });

  it("rejects setup problems with HTTP 400", async () => {
    const repo = await import("@/server/repo");
    const route = await import("@/app/api/grpc/route");
    const ws = repo.createWorkspace("gRPC errors");
    const post = (request: object) =>
      route.POST(
        new Request("http://localhost/api/grpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: ws.id, request }),
        }),
      );
    const grpcSettings = (method: string) => ({
      grpc: { protos: { "echo.proto": PROTO }, service: "test.Echo", method },
    });
    const raw = (text: string) => ({ mode: "raw", raw: text, language: "json" });
    const cases: [object, RegExp][] = [
      [{ url: plainUrl }, /Add \.proto definitions/],
      [{ url: plainUrl, body: raw("{nope"), settings: grpcSettings("Unary") }, /valid JSON/],
      [{ url: plainUrl, body: raw("[{}]"), settings: grpcSettings("Unary") }, /single message/],
      [{ url: plainUrl, settings: grpcSettings("Missing") }, /not defined/],
      [{ url: "http://127.0.0.1:1", settings: grpcSettings("Unary") }, /grpc:\/\//],
      [
        {
          url: plainUrl,
          auth: { type: "digest", digest: { username: "u", password: "p" } },
          settings: grpcSettings("Unary"),
        },
        /cannot be used for gRPC/,
      ],
    ];
    for (const [request, message] of cases) {
      const res = await post(request);
      expect(res.status, JSON.stringify(request)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
  });
});
