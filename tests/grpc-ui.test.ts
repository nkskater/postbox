import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isGrpcUrl,
  logEntry,
  methodOptions,
  nextProtoName,
  renameProto,
  streamingKind,
  type GrpcServiceSummary,
} from "@/lib/grpc";

const method = (name: string, clientStreaming: boolean, serverStreaming: boolean) => ({
  name,
  path: `/p.S/${name}`,
  requestType: "p.M",
  responseType: "p.M",
  clientStreaming,
  serverStreaming,
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-grpc-ui-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

describe("gRPC request persistence", () => {
  it("round-trips gRPC settings through save and update", async () => {
    const repo = await import("@/server/repo");
    const ws = repo.createWorkspace("grpc persist");
    const folder = repo.createFolder(ws.id, null, { name: "f" });
    const grpc = {
      protos: { "a.proto": 'syntax = "proto3"; package a; message M {}' },
      service: "a.S",
      method: "Do",
    };
    const created = repo.createRequest(ws.id, folder.id, {
      name: "call",
      url: "grpc://localhost:50051",
      settings: { ...(await import("@/core/types")).DEFAULT_SETTINGS, grpc },
    });
    expect(repo.getRequest(created.id)!.settings.grpc).toEqual(grpc);
    repo.updateRequest(created.id, {
      settings: { ...created.settings, grpc: { ...grpc, reflection: true, protos: {} } },
    });
    expect(repo.getRequest(created.id)!.settings.grpc).toEqual({ ...grpc, reflection: true, protos: {} });
  });
});

describe("gRPC editor helpers", () => {
  it("detects gRPC URLs", () => {
    expect(isGrpcUrl("grpc://localhost:50051")).toBe(true);
    expect(isGrpcUrl("  GRPCS://example.com")).toBe(true);
    expect(isGrpcUrl("https://example.com")).toBe(false);
    expect(isGrpcUrl("{{base}}/x")).toBe(false);
  });

  it("describes streaming kinds and builds method options", () => {
    expect(streamingKind(method("A", false, false))).toBe("unary");
    expect(streamingKind(method("B", true, false))).toBe("client streaming");
    expect(streamingKind(method("C", false, true))).toBe("server streaming");
    expect(streamingKind(method("D", true, true))).toBe("bidirectional streaming");
    const services: GrpcServiceSummary[] = [
      { name: "S", fullName: "p.S", methods: [method("A", false, false), method("D", true, true)] },
    ];
    expect(methodOptions(services).map((o) => [o.value, o.kind])).toEqual([
      ["p.S/A", "unary"],
      ["p.S/D", "bidirectional streaming"],
    ]);
  });

  it("renames proto files in place and rejects empty or clashing names", () => {
    const protos = { "a.proto": "A", "b.proto": "B", "c.proto": "C" };
    expect(Object.keys(renameProto(protos, "b.proto", "x.proto"))).toEqual(["a.proto", "x.proto", "c.proto"]);
    expect(renameProto(protos, "b.proto", "a.proto")).toBe(protos);
    expect(renameProto(protos, "b.proto", "  ")).toBe(protos);
    expect(renameProto(protos, "b.proto", "b.proto")).toEqual(protos);
  });

  it("picks unique new proto names", () => {
    expect(nextProtoName({})).toBe("service.proto");
    expect(nextProtoName({ "service.proto": "" })).toBe("service-2.proto");
    expect(nextProtoName({ "service.proto": "", "service-2.proto": "" })).toBe("service-3.proto");
  });

  it("turns events into log rows", () => {
    expect(logEntry({ type: "session", id: "x" })).toBeNull();
    expect(logEntry({ type: "message", index: 0, message: { a: 1 }, size: 3, at: 5 })).toMatchObject({
      kind: "in",
      title: "Message #1",
      text: '{\n  "a": 1\n}',
    });
    expect(logEntry({ type: "sent", index: 1, message: { b: 2 }, at: 5 })).toMatchObject({
      kind: "out",
      title: "Sent #2",
    });
    const ok = logEntry({
      type: "status",
      code: 0,
      codeName: "OK",
      details: "OK",
      trailers: [["x", "1"]],
      at: 1,
    });
    expect(ok).toMatchObject({ kind: "info", text: "OK (0)\nx: 1" });
    const bad = logEntry({
      type: "status",
      code: 5,
      codeName: "NOT_FOUND",
      details: "nope",
      trailers: [],
      at: 1,
    });
    expect(bad).toMatchObject({ kind: "error", text: "NOT_FOUND (5): nope" });
    expect(logEntry({ type: "error", error: "boom" })).toMatchObject({ kind: "error", text: "boom" });
  });
});
