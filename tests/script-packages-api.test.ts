import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-script-packages-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo"),
  packages: typeof import("@/server/script-packages"),
  context: typeof import("@/server/context"),
  runs: typeof import("@/server/runs"),
  scheduler: typeof import("@/server/scheduler"),
  server: http.Server,
  base: string;
beforeAll(async () => {
  repo = await import("@/server/repo");
  packages = await import("@/server/script-packages");
  context = await import("@/server/context");
  runs = await import("@/server/runs");
  scheduler = await import("@/server/scheduler");
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  scheduler.stopScheduler();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const setup = () => {
  const ws = repo.createWorkspace("Packages"),
    folder = repo.createFolder(ws.id, null);
  const pkg = packages.createScriptPackage(ws.id, {
    name: "utils",
    source: "exports.value=1;",
    approved: true,
  });
  return { ws, folder, pkg };
};
const send = (ws: { id: string }, folder: { id: string }, testScript: string) =>
  context.runSingleRequest({
    workspaceId: ws.id,
    folderId: folder.id,
    environmentId: null,
    request: repo.createRequest(ws.id, folder.id, { url: base, testScript }),
  });
describe("versioned script packages", () => {
  it("counts every retained version toward workspace storage without recording source in audit changes", async () => {
    const { storageBytes } = await import("@/server/usage");
    const { describeChange, entityKindOf } = await import("@/core/audit");
    const ws = repo.createWorkspace("Package storage");
    const before = storageBytes(ws.id);
    const source = "exports.value=1; // é";
    const pkg = packages.createScriptPackage(ws.id, { name: "metered", source });
    expect(storageBytes(ws.id) - before).toBe(Buffer.byteLength(source));
    packages.reviseScriptPackage(pkg.id, { expectedVersion: 1, source });
    expect(storageBytes(ws.id) - before).toBe(Buffer.byteLength(source) * 2);
    expect(entityKindOf("/api/script-packages/[id]/versions")).toBe("scriptPackage");
    expect(JSON.stringify(describeChange("scriptPackage", {}, { source }))).not.toContain(source);
  });
  it("creates immutable code, checks stale revisions and caches only immutable definitions", () => {
    const { ws, pkg } = setup();
    const first = packages.moduleSnapshot(ws.id),
      second = packages.moduleSnapshot(ws.id);
    expect(first.modules["@team/utils@1"]).toBe(second.modules["@team/utils@1"]);
    expect(Object.isFrozen(first.modules["@team/utils@1"])).toBe(true);
    expect(packages.moduleCacheSize()).toBeLessThanOrEqual(128);
    const updated = packages.reviseScriptPackage(pkg.id, { expectedVersion: 1, source: "exports.value=2;" });
    expect(updated.version).toBe(2);
    expect(updated.approved).toBe(false);
    expect(packages.getScriptPackage(pkg.id, 1).source).toBe("exports.value=1;");
    expect(() =>
      packages.reviseScriptPackage(pkg.id, { expectedVersion: 1, source: "exports.value=3;" }),
    ).toThrow(/changed/);
    expect(() => packages.createScriptPackage(ws.id, { name: "utils", source: "exports.a=1;" })).toThrow(
      /already exists/,
    );
  });
  it("reuses approved packages across collections while pins remain stable and revocation takes effect", async () => {
    const { ws, folder, pkg } = setup(),
      other = repo.createFolder(ws.id, null);
    for (const target of [folder, other]) {
      const result = await send(
        ws,
        target,
        'pm.test("shared",()=>pm.expect(pm.require("@team/utils@1").value).to.equal(1));',
      );
      expect(result.tests[0].passed).toBe(true);
    }
    packages.reviseScriptPackage(pkg.id, { expectedVersion: 1, source: "exports.value=2;" });
    expect((await send(ws, folder, 'pm.require("@team/utils");')).scriptErrors[0].message).toMatch(
      /unavailable|not approved/,
    );
    packages.approveScriptPackage(pkg.id, 2, true);
    expect(
      (
        await send(
          ws,
          folder,
          'pm.test("latest",()=>pm.expect(pm.require("@team/utils").value).to.equal(2));',
        )
      ).tests[0].passed,
    ).toBe(true);
    expect(
      (await send(ws, folder, 'pm.test("pin",()=>pm.expect(pm.require("@team/utils@1").value).to.equal(1));'))
        .tests[0].passed,
    ).toBe(true);
    packages.approveScriptPackage(pkg.id, 1, false);
    expect((await send(ws, folder, 'pm.require("@team/utils@1");')).scriptErrors[0].message).toMatch(
      /unavailable|not approved/,
    );
  });
  it("supports collection runs, schedules and saved request calls across collections", async () => {
    const { ws, folder, pkg } = setup(),
      childFolder = repo.createFolder(ws.id, null);
    const child = repo.createRequest(ws.id, childFolder.id, {
      url: base,
      testScript: 'pm.test("child package",()=>pm.expect(pm.require("@team/utils@1").value).to.equal(1));',
    });
    repo.createRequest(ws.id, folder.id, {
      url: base,
      testScript: `await pm.execution.runRequest("${child.id}");pm.test("parent package",()=>pm.expect(pm.require("@team/utils@1").value).to.equal(1));`,
    });
    const result = await runs.startRun({ workspaceId: ws.id, folderId: folder.id, environmentId: null });
    expect(result.summary.status).toBe("passed");
    expect(result.summary.failedTests).toBe(0);
    const schedule = scheduler.createSchedule({
      workspaceId: ws.id,
      folderId: folder.id,
      name: "Package schedule",
      cron: "0 0 * * *",
      enabled: false,
    });
    const started = await scheduler.runSchedule(schedule.id);
    const deadline = Date.now() + 5000;
    while (
      ["running", "queued"].includes(runs.listRuns(ws.id).find((r) => r.id === started.runId)?.status ?? "")
    ) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runs.getRunSummary(started.runId)?.status).toBe("passed");
    expect(packages.packageReferences(pkg.id).length).toBeGreaterThan(0);
  });
  it("guards saved and package dependency references before deleting code", () => {
    const { ws, folder, pkg } = setup();
    const request = repo.createRequest(ws.id, folder.id, {
      url: base,
      testScript: 'pm.require("@team/utils@1");',
    });
    const dependent = packages.createScriptPackage(ws.id, {
      name: "dependent",
      source: 'module.exports=require("@team/utils@1");',
    });
    expect(() => packages.deleteScriptPackage(pkg.id)).toThrow(/referenced/);
    repo.updateRequest(request.id, { testScript: "" });
    expect(packages.packageReferences(pkg.id).some((ref) => ref.kind === "package")).toBe(true);
    packages.deleteScriptPackage(dependent.id);
    packages.deleteScriptPackage(pkg.id);
    expect(packages.moduleSnapshot(ws.id).modules).toEqual({});
  });
  it("rejects oversized code and keeps credentials in runtime variables rather than module cache", async () => {
    const { ws, folder } = setup();
    expect(() => packages.createScriptPackage(ws.id, { name: "large", source: "é".repeat(40000) })).toThrow(
      /64 KiB/,
    );
    repo.replaceVariables(ws.id, "global", null, [
      { key: "secret", value: "package-sensitive-value", type: "secret", enabled: true },
    ]);
    packages.createScriptPackage(ws.id, {
      name: "secrets",
      source: 'exports.log=function(){console.log(pm.globals.get("secret"));};',
      approved: true,
    });
    const result = await send(ws, folder, 'pm.require("@team/secrets@1").log();');
    expect(JSON.stringify(result.logs)).not.toContain("package-sensitive-value");
    expect(JSON.stringify(packages.moduleSnapshot(ws.id))).not.toContain("package-sensitive-value");
  });
  it("round-trips package definitions in backups but requires review after restoration", async () => {
    const { ws, pkg } = setup();
    repo.replaceVariables(ws.id, "global", null, [
      { key: "secret", value: "backup-code-secret", type: "secret", enabled: true },
    ]);
    packages.createScriptPackage(ws.id, {
      name: "credential",
      source: 'exports.value="backup-code-secret";',
      approved: true,
    });
    const dbm = await import("@/server/db"),
      backup = await import("@/server/backup");
    const full = backup.createBackup(dbm.getDb(), { includeSecrets: true }),
      safe = backup.createBackup(dbm.getDb(), { includeSecrets: false });
    expect(JSON.stringify(safe.tables.scriptPackageVersions)).not.toContain("backup-code-secret");
    for (const version of safe.tables.scriptPackageVersions)
      expect(version.hash).toBe(createHash("sha256").update(String(version.source)).digest("hex"));
    const fresh = dbm.openDatabase(path.join(directory, "restore.db"));
    try {
      const result = backup.restoreBackup(fresh.db, fresh.sqlite, JSON.parse(JSON.stringify(full)));
      expect(result.scriptPackages).toBeGreaterThan(0);
      const restored = fresh.db
        .select()
        .from(dbm.schema.scriptPackageVersions)
        .all()
        .find((v) => v.packageId === pkg.id)!;
      expect(restored.source).toBe(pkg.source);
      expect(restored.approved).toBe(false);
    } finally {
      fresh.sqlite.close();
    }
  });
  it("enforces read/write/owner approval permissions and rejects cross-workspace package imports", async () => {
    const users = await import("@/server/users"),
      { withCaller } = await import("@/server/access-context"),
      { setMember } = await import("@/server/authorize");
    await users.createUser({ username: "admin", password: "password123", isAdmin: true });
    const owner = await users.createUser({ username: "owner", password: "password123" }),
      editor = await users.createUser({ username: "editor", password: "password123" }),
      viewer = await users.createUser({ username: "viewer", password: "password123" }),
      outsider = await users.createUser({ username: "outsider", password: "password123" });
    const caller = { kind: "user" as const, user: owner, via: "token" as const };
    const ws = withCaller(caller, () => repo.createWorkspace("Private packages"));
    withCaller(caller, () => {
      setMember(ws.id, editor.username, "editor");
      setMember(ws.id, viewer.username, "viewer");
    });
    const pkg = withCaller(caller, () =>
      packages.createScriptPackage(ws.id, { name: "private", source: "exports.value=1;" }),
    );
    const route = await import("@/app/api/script-packages/[id]/route"),
      approve = await import("@/app/api/script-packages/[id]/approval/route");
    const req = (user: typeof owner, method = "GET", body?: unknown) =>
      new Request(`http://localhost/api/script-packages/${pkg.id}${method === "POST" ? "/approval" : ""}`, {
        method,
        headers: {
          authorization: `Bearer ${users.createToken(user.id, "test").token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const context = { params: Promise.resolve({ id: pkg.id }) };
    expect((await route.GET(req(viewer), context)).status).toBe(200);
    expect((await route.GET(req(outsider), context)).status).toBe(404);
    expect((await approve.POST(req(editor, "POST", { version: 1, approved: true }), context)).status).toBe(
      403,
    );
    expect((await approve.POST(req(owner, "POST", { version: 1, approved: true }), context)).status).toBe(
      200,
    );
    const foreign = repo.createWorkspace("Foreign");
    expect(packages.moduleSnapshot(foreign.id).modules).toEqual({});
  });
});
