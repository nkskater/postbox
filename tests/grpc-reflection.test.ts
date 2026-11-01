import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import "protobufjs/ext/descriptor";
import { describeServices, loadProtoRoot, resolveMethod } from "@/core/grpc/proto";
import { protoFor, reflectRoot, type ReflectionInput } from "@/core/grpc/reflection";
import { HostPolicy } from "@/core/http/policy";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-reflect-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const PROTO = `
syntax = "proto3";
package test;
import "google/protobuf/timestamp.proto";
service Echo {
  rpc Unary(Msg) returns (Msg);
  rpc Bidi(stream Msg) returns (stream Msg);
}
message Msg { string text = 1; google.protobuf.Timestamp at = 2; }
`;

type Descriptors = {
  FileDescriptorProto: { encode(f: unknown): { finish(): Uint8Array } };
};
const descriptor = (protobuf as unknown as { descriptor: Descriptors }).descriptor;

// Descriptor files as a real server would hold them: the service file depends on the
// well-known Timestamp file, which is only returned when asked for by name.
const files = new Map<string, Buffer>();
{
  const root = loadProtoRoot({ "echo.proto": PROTO });
  const set = (
    root as unknown as { toDescriptor(syntax: string): { file: { name: string; dependency: string[] }[] } }
  ).toDescriptor("proto3");
  const service = set.file.find((f) => f.name === "test.proto")!;
  const timestamp = set.file.find((f) => f.name !== "test.proto")!;
  timestamp.name = "google/protobuf/timestamp.proto";
  service.dependency = ["google/protobuf/timestamp.proto"];
  files.set("test.proto", Buffer.from(descriptor.FileDescriptorProto.encode(service).finish()));
  files.set(
    "google/protobuf/timestamp.proto",
    Buffer.from(descriptor.FileDescriptorProto.encode(timestamp).finish()),
  );
}
const symbolFile: Record<string, string> = { "test.Echo": "test.proto" };

const id = (b: Buffer) => b;
const methodDef = (p: string, requestStream: boolean, responseStream: boolean) => ({
  path: p,
  requestStream,
  responseStream,
  requestSerialize: id,
  requestDeserialize: id,
  responseSerialize: id,
  responseDeserialize: id,
});

const Msg = loadProtoRoot({ "echo.proto": PROTO }).lookupType("test.Msg");
const echoDef = {
  Unary: methodDef("/test.Echo/Unary", false, false),
  Bidi: methodDef("/test.Echo/Bidi", true, true),
} as unknown as grpc.ServiceDefinition;
const echoImpl = {
  Unary: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    seen.push(call.metadata.getMap() as unknown as Record<string, string>);
    const m = Msg.toObject(Msg.decode(call.request)) as { text: string };
    cb(null, Buffer.from(Msg.encode(Msg.fromObject({ text: `echo ${m.text}` })).finish()));
  },
  Bidi: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
    call.on("data", (b: Buffer) => call.write(b));
    call.on("end", () => call.end());
  },
};
const seen: Record<string, string>[] = [];

function reflectionService(version: "v1" | "v1alpha", mode: "ok" | "silent" = "ok") {
  const proto = protoFor(version);
  const def = {
    ServerReflectionInfo: methodDef(proto.path, true, true),
  } as unknown as grpc.ServiceDefinition;
  const impl = {
    ServerReflectionInfo: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
      seen.push(call.metadata.getMap() as unknown as Record<string, string>);
      call.on("data", (b: Buffer) => {
        if (mode === "silent") return;
        const req = proto.request.toObject(proto.request.decode(b), { oneofs: true }) as Record<
          string,
          string
        >;
        let response: object;
        if (req.list_services)
          response = {
            list_services_response: {
              service: [{ name: "test.Echo" }, { name: `grpc.reflection.${version}.ServerReflection` }],
            },
          };
        else {
          const name = req.file_containing_symbol
            ? symbolFile[req.file_containing_symbol]
            : req.file_by_filename;
          const file = name ? files.get(name) : undefined;
          response = file
            ? { file_descriptor_response: { file_descriptor_proto: [file] } }
            : {
                error_response: {
                  error_code: 5,
                  error_message: `not found: ${req.file_containing_symbol ?? req.file_by_filename}`,
                },
              };
        }
        call.write(Buffer.from(proto.response.encode(proto.response.fromObject(response)).finish()));
      });
      call.on("end", () => call.end());
    },
  };
  return { def, impl };
}

const servers: grpc.Server[] = [];
async function start(setup: (s: grpc.Server) => void): Promise<string> {
  const server = new grpc.Server();
  setup(server);
  servers.push(server);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  return `grpc://127.0.0.1:${port}`;
}
const withEcho = (s: grpc.Server) =>
  s.addService(echoDef, echoImpl as unknown as grpc.UntypedServiceImplementation);
const withReflection =
  (version: "v1" | "v1alpha", mode: "ok" | "silent" = "ok") =>
  (s: grpc.Server) => {
    const r = reflectionService(version, mode);
    s.addService(r.def, r.impl as unknown as grpc.UntypedServiceImplementation);
  };

let v1Url: string;
let alphaUrl: string;
let noReflectionUrl: string;
let silentUrl: string;
beforeAll(async () => {
  v1Url = await start((s) => (withEcho(s), withReflection("v1")(s)));
  alphaUrl = await start((s) => (withEcho(s), withReflection("v1alpha")(s)));
  noReflectionUrl = await start(withEcho);
  silentUrl = await start((s) => (withEcho(s), withReflection("v1", "silent")(s)));
});
afterAll(() => {
  for (const s of servers) s.forceShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const input = (url: string, extra: Partial<ReflectionInput> = {}): ReflectionInput => ({
  url,
  metadata: [],
  verifySsl: true,
  timeoutMs: 5000,
  ...extra,
});

describe("gRPC reflection", () => {
  it("discovers services and methods, following file dependencies", async () => {
    const root = await reflectRoot(input(v1Url));
    const services = describeServices(root);
    expect(services.map((s) => s.fullName)).toEqual(["test.Echo"]);
    const byName = Object.fromEntries(services[0].methods.map((m) => [m.name, m]));
    expect(byName.Unary).toMatchObject({
      clientStreaming: false,
      serverStreaming: false,
      requestType: "test.Msg",
    });
    expect(byName.Bidi).toMatchObject({ clientStreaming: true, serverStreaming: true });
    // The Timestamp field only resolves if the dependency file was fetched by name.
    expect(root.lookupType("test.Msg").fields.at.type).toBe("google.protobuf.Timestamp");
    expect(resolveMethod(root, "Echo", "Unary").info.path).toBe("/test.Echo/Unary");
  });

  it("falls back to v1alpha", async () => {
    const services = describeServices(await reflectRoot(input(alphaUrl)));
    expect(services[0].fullName).toBe("test.Echo");
  });

  it("explains when reflection is not available", async () => {
    await expect(reflectRoot(input(noReflectionUrl))).rejects.toThrow(/does not support gRPC reflection/);
  });

  it("sends metadata with reflection requests", async () => {
    await reflectRoot(input(v1Url, { metadata: [["Authorization", "Bearer tok"]] }));
    expect(seen.at(-1)!.authorization).toBe("Bearer tok");
  });

  it("times out and cancels", async () => {
    await expect(reflectRoot(input(silentUrl, { timeoutMs: 300 }))).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const pending = reflectRoot(input(silentUrl), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("applies the host policy to every resolved address, and falls back between them", async () => {
    const port = v1Url.split(":").at(-1);
    await expect(reflectRoot(input(v1Url), { policy: new HostPolicy([], ["127.0.0.0/8"]) })).rejects.toThrow(
      /PROXY_DENY_HOSTS|denied/,
    );
    const lookup = vi.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    try {
      const root = await reflectRoot(input(`grpc://dual.test:${port}`));
      expect(describeServices(root)[0].fullName).toBe("test.Echo");
      lookup.mockResolvedValue([
        { address: "127.0.0.1", family: 4 },
        { address: "10.9.9.9", family: 4 },
      ] as never);
      await expect(
        reflectRoot(input(`grpc://rebind.test:${port}`), { policy: new HostPolicy([], ["10.0.0.0/8"]) }),
      ).rejects.toThrow(/PROXY_DENY_HOSTS|denied/);
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("gRPC reflection API", () => {
  async function post<T extends { POST(req: Request): Promise<Response> }>(route: T, body: object) {
    return route.POST(
      new Request("http://localhost/api/grpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("lists services through /api/grpc/reflect", async () => {
    const repo = await import("@/server/repo");
    const reflect = await import("@/app/api/grpc/reflect/route");
    const ws = repo.createWorkspace("reflect");
    const ok = await post(reflect, { workspaceId: ws.id, request: { url: v1Url } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { services: { fullName: string }[] };
    expect(body.services.map((s) => s.fullName)).toEqual(["test.Echo"]);
    const bad = await post(reflect, { workspaceId: ws.id, request: { url: noReflectionUrl } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/reflection/);
  });

  it("calls methods discovered by reflection, with auth metadata and redaction", async () => {
    const repo = await import("@/server/repo");
    const call = await import("@/app/api/grpc/route");
    const ws = repo.createWorkspace("reflect call");
    const folder = repo.createFolder(ws.id, null, {
      name: "c",
      auth: { type: "bearer", bearer: { token: "{{tok}}" } },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "tok", value: "reflect-secret", type: "secret", enabled: true },
    ]);
    const run = async (url: string, method: string, raw: string) => {
      const res = await post(call, {
        workspaceId: ws.id,
        folderId: folder.id,
        request: {
          url,
          body: { mode: "raw", raw, language: "json" },
          settings: { grpc: { protos: {}, reflection: true, service: "test.Echo", method } },
        },
      });
      return res;
    };
    const unary = await run(v1Url, "Unary", '{"text": "hi"}');
    expect(unary.status).toBe(200);
    const events = (await unary.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; message?: unknown });
    expect(events.find((e) => e.type === "message")!.message).toMatchObject({ text: "echo hi" });
    expect(seen.some((m) => m.authorization === "Bearer reflect-secret")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("reflect-secret");

    const bidi = await run(v1Url, "Bidi", '[{"text": "a"}, {"text": "b"}]');
    const texts = (await bidi.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; message?: { text: string } })
      .filter((e) => e.type === "message")
      .map((e) => e.message!.text);
    expect(texts).toEqual(["a", "b"]);

    const missing = await run(noReflectionUrl, "Unary", "{}");
    expect(missing.status).toBe(400);
    const unknown = await run(v1Url, "Nope", "{}");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/not defined/);
  });
});
