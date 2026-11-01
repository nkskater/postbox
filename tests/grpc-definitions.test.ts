import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-grpc-defs-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

type Defs = typeof import("@/server/grpc-definitions");
let defs: Defs;
let repo: typeof import("@/server/repo");
let server: grpc.Server;
let url = "";

const V1 = `syntax = "proto3"; package shop; service Echo { rpc Say(M) returns (M); } message M { string text = 1; }`;
const V2 = `syntax = "proto3"; package shop; service Echo { rpc Say(M) returns (M); rpc Shout(M) returns (M); } message M { string text = 1; }`;

beforeAll(async () => {
  defs = await import("@/server/grpc-definitions");
  repo = await import("@/server/repo");
  const id = (b: Buffer) => b;
  const method = (p: string) => ({
    path: p,
    requestStream: false,
    responseStream: false,
    requestSerialize: id,
    requestDeserialize: id,
    responseSerialize: id,
    responseDeserialize: id,
  });
  const reply = (_call: unknown, cb: grpc.sendUnaryData<Buffer>) =>
    cb(null, Buffer.concat([Buffer.from([0x0a, 2]), Buffer.from("ok")]));
  server = new grpc.Server();
  server.addService(
    { Say: method("/shop.Echo/Say"), Shout: method("/shop.Echo/Shout") } as unknown as grpc.ServiceDefinition,
    { Say: reply, Shout: reply } as unknown as grpc.UntypedServiceImplementation,
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  url = `grpc://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.forceShutdown();
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const grpcRequest = (workspaceId: string, request: object) =>
  import("@/app/api/grpc/route").then((r) =>
    r.POST(
      new Request("http://localhost/api/grpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, request }),
      }),
    ),
  );
const call = async (workspaceId: string, definitionId: string, method: string) => {
  const res = await grpcRequest(workspaceId, {
    url,
    body: { mode: "raw", raw: '{"text":"hi"}', language: "json" },
    settings: { grpc: { protos: {}, definitionId, service: "shop.Echo", method } },
  });
  if (res.status !== 200)
    return { status: res.status, error: ((await res.json()) as { error: string }).error };
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { text: string }; codeName?: string });
  return { status: 200, events };
};

describe("shared gRPC definitions", () => {
  it("creates, lists, reads and updates a set, validating the files", () => {
    const ws = repo.createWorkspace("Defs");
    const created = defs.createDefinition({
      workspaceId: ws.id,
      name: "Shop API",
      description: "Orders",
      files: { "shop.proto": V1 },
    });
    expect(created).toMatchObject({ name: "Shop API", revision: 1, fileCount: 1, usedBy: [], canEdit: true });
    expect(created.files).toEqual({ "shop.proto": V1 });

    const [listed] = defs.listDefinitions(ws.id);
    expect(listed.id).toBe(created.id);
    expect(listed).not.toHaveProperty("files"); // the list stays light

    // Files bump the revision; metadata alone does not.
    expect(defs.updateDefinition(created.id, { name: "Shop API v2" })).toMatchObject({
      name: "Shop API v2",
      revision: 1,
    });
    expect(defs.updateDefinition(created.id, { files: { "shop.proto": V2 } })).toMatchObject({ revision: 2 });

    // Bad files are refused before anything is stored.
    expect(() =>
      defs.createDefinition({ workspaceId: ws.id, name: "Broken", files: { "x.proto": "not proto" } }),
    ).toThrow(/x\.proto/);
    expect(() =>
      defs.createDefinition({
        workspaceId: ws.id,
        name: "Missing import",
        files: { "x.proto": 'syntax="proto3"; import "other.proto";' },
      }),
    ).toThrow(/other\.proto/);
    expect(() => defs.updateDefinition(created.id, { files: { "shop.proto": "nope" } })).toThrow();
    expect(defs.getDefinition(created.id).revision).toBe(2);
    expect(() => defs.createDefinition({ workspaceId: ws.id, name: "Empty", files: {} })).toThrow();
    expect(() =>
      defs.createDefinition({ workspaceId: ws.id, name: "   ", files: { "a.proto": V1 } }),
    ).toThrow();
    expect(() => defs.getDefinition("missing")).toThrow(/not found/i);
  });

  it("keeps names unique within a workspace only", () => {
    const a = repo.createWorkspace("A");
    const b = repo.createWorkspace("B");
    const first = defs.createDefinition({ workspaceId: a.id, name: "Same", files: { "a.proto": V1 } });
    expect(() =>
      defs.createDefinition({ workspaceId: a.id, name: "Same", files: { "a.proto": V1 } }),
    ).toThrow(/already exists/);
    expect(() =>
      defs.createDefinition({ workspaceId: b.id, name: "Same", files: { "a.proto": V1 } }),
    ).not.toThrow();
    const other = defs.createDefinition({ workspaceId: a.id, name: "Other", files: { "a.proto": V1 } });
    expect(() => defs.updateDefinition(other.id, { name: "Same" })).toThrow(/already exists/);
    expect(first.id).not.toBe(other.id);
  });

  it("serves several requests from one set, and an edit reaches all of them", async () => {
    const ws = repo.createWorkspace("Shared");
    const def = defs.createDefinition({ workspaceId: ws.id, name: "Shop", files: { "shop.proto": V1 } });
    const ok = await call(ws.id, def.id, "Say");
    expect(ok.events!.find((e) => e.type === "message")!.message).toEqual({ text: "ok" });
    expect(ok.events!.find((e) => e.type === "status")).toMatchObject({ codeName: "OK" });
    // Shout does not exist yet: both a request calling it and one calling Say follow the same set.
    expect((await call(ws.id, def.id, "Shout")).error).toMatch(/not defined/);
    defs.updateDefinition(def.id, { files: { "shop.proto": V2 } });
    expect((await call(ws.id, def.id, "Shout")).events!.find((e) => e.type === "message")!.message).toEqual({
      text: "ok",
    });
    expect((await call(ws.id, def.id, "Say")).status).toBe(200);
  });

  it("never serves a definition from another workspace", async () => {
    const mine = repo.createWorkspace("Mine");
    const theirs = repo.createWorkspace("Theirs");
    const secret = defs.createDefinition({
      workspaceId: theirs.id,
      name: "Private",
      files: { "shop.proto": V1 },
    });
    const attempt = await call(mine.id, secret.id, "Say");
    expect(attempt.status).toBe(404);
    expect(attempt.error).toMatch(/not found in this workspace/);
    const describe = await import("@/app/api/grpc/describe/route");
    const res = await describe.POST(
      new Request("http://localhost/api/grpc/describe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: mine.id, definitionId: secret.id }),
      }),
    );
    expect(res.status).toBe(404);
    expect(() => defs.definitionFiles(mine.id, secret.id)).toThrow();
    expect(defs.definitionFiles(theirs.id, secret.id)).toEqual({ "shop.proto": V1 });
  });

  it("lists methods for a shared set through the describe route", async () => {
    const ws = repo.createWorkspace("Describe");
    const def = defs.createDefinition({ workspaceId: ws.id, name: "Shop", files: { "shop.proto": V2 } });
    const { POST } = await import("@/app/api/grpc/describe/route");
    const post = (body: object) =>
      POST(
        new Request("http://localhost/api/grpc/describe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const res = await post({ workspaceId: ws.id, definitionId: def.id });
    expect(
      ((await res.json()) as { services: { methods: { name: string }[] }[] }).services[0].methods.map(
        (m) => m.name,
      ),
    ).toEqual(["Say", "Shout"]);
    expect((await post({ workspaceId: ws.id })).status).toBe(400);
  });

  it("refuses to delete a set that requests still use, and names them", () => {
    const ws = repo.createWorkspace("In use");
    const def = defs.createDefinition({ workspaceId: ws.id, name: "Shop", files: { "shop.proto": V1 } });
    const folder = repo.createFolder(ws.id, null, { name: "C" });
    const settings = (definitionId?: string) => ({
      followRedirects: true,
      maxRedirects: 10,
      timeoutMs: 30000,
      verifySsl: true,
      useCookieJar: true,
      grpc: { protos: {}, service: "shop.Echo", method: "Say", ...(definitionId ? { definitionId } : {}) },
    });
    const one = repo.createRequest(ws.id, folder.id, {
      name: "Say hello",
      url: "grpc://x:1",
      settings: settings(def.id),
    });
    repo.createRequest(ws.id, folder.id, {
      name: "Say goodbye",
      url: "grpc://x:1",
      settings: settings(def.id),
    });
    repo.createRequest(ws.id, folder.id, { name: "Unrelated", url: "grpc://x:1", settings: settings() });

    expect(defs.getDefinition(def.id).usedBy.map((u) => u.name)).toEqual(["Say goodbye", "Say hello"]);
    expect(defs.listDefinitions(ws.id)[0].usedBy).toHaveLength(2);
    expect(() => defs.deleteDefinition(def.id)).toThrow(/used by 2 requests \(Say goodbye, Say hello\)/);
    repo.updateRequest(one.id, { settings: settings() });
    expect(() => defs.deleteDefinition(def.id)).toThrow(/used by 1 request \(Say goodbye\)/);
    for (const r of repo.getTreeSummary(ws.id).requests) repo.updateRequest(r.id, { settings: settings() });
    expect(defs.deleteDefinition(def.id)).toEqual({ ok: true });
    expect(defs.listDefinitions(ws.id)).toEqual([]);
  });

  it("is removed with its workspace and kept in backups", async () => {
    const { createBackup, restoreBackup } = await import("@/server/backup");
    const { getDb, openDatabase } = await import("@/server/db");
    const ws = repo.createWorkspace("Backed up");
    const def = defs.createDefinition({
      workspaceId: ws.id,
      name: "Shop",
      description: "d",
      files: { "shop.proto": V1 },
    });
    const backup = JSON.parse(JSON.stringify(createBackup(getDb(), { includeSecrets: false })));
    expect(backup.tables.grpcDefinitions.some((d: { id: string }) => d.id === def.id)).toBe(true);
    const fresh = openDatabase(path.join(dir, "restore.db"));
    restoreBackup(fresh.db, fresh.sqlite, backup);
    const restored = fresh.db
      .select()
      .from((await import("@/server/db")).schema.grpcDefinitions)
      .all()
      .find((d) => d.id === def.id)!;
    expect(restored).toMatchObject({
      name: "Shop",
      description: "d",
      revision: 1,
      files: { "shop.proto": V1 },
    });
    fresh.sqlite.close();
    repo.deleteWorkspace(ws.id);
    expect(() => defs.getDefinition(def.id)).toThrow(/not found/i);
  });
});
