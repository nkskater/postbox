import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-backup-"));
process.env.DATABASE_PATH = path.join(dir, "source.db");

type Db = typeof import("@/server/db");
type Backup = typeof import("@/server/backup");
type Repo = typeof import("@/server/repo");
let dbm: Db;
let bk: Backup;
let repo: Repo;
let ws: { id: string };
let server: http.Server;
let base = "";

const fresh = (name: string) => dbm.openDatabase(path.join(dir, `${name}.db`));
/** A backup as it would travel through a downloaded file. */
const roundTrip = (b: unknown) => JSON.parse(JSON.stringify(b));
const stable = (b: { tables: unknown }) => JSON.stringify(b.tables);

beforeAll(async () => {
  dbm = await import("@/server/db");
  bk = await import("@/server/backup");
  repo = await import("@/server/repo");
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ws = repo.createWorkspace("Backup source");
  const folder = repo.createFolder(ws.id, null, {
    name: "API",
    auth: { type: "bearer", bearer: { token: "folder-token-123" } },
    headers: [
      { key: "Authorization", value: "Bearer folder-header-456", enabled: true },
      { key: "X-Trace", value: "t", enabled: true },
    ],
  });
  repo.createRequest(ws.id, folder.id, {
    name: "Get thing",
    url: "https://example.test/thing",
    auth: { type: "basic", basic: { username: "u", password: "request-password-789" } },
    settings: {
      ...DEFAULT_SETTINGS,
      grpc: { protos: { "a.proto": "syntax = 'proto3';" }, service: "a.S", method: "Do" },
    },
  });
  repo.createEnvironment(ws.id, "Staging", [
    { key: "host", value: "staging.test", type: "default", enabled: true },
    { key: "apiKey", value: "env-secret-abc", type: "secret", enabled: true },
  ]);
  repo.replaceVariables(ws.id, "collection", folder.id, [
    { key: "region", value: "eu", type: "default", enabled: true },
    { key: "pw", value: "collection-secret-def", type: "secret", enabled: true },
  ]);
  const db = dbm.getDb();
  db.insert(dbm.schema.datasets)
    .values({
      id: "ds1",
      workspaceId: ws.id,
      name: "Users",
      description: "",
      latestVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(dbm.schema.datasetVersions)
    .values({
      datasetId: "ds1",
      version: 1,
      table: { columns: ["name", "password"], rows: [{ name: "ann", password: "dataset-secret-ghi" }] },
      secretColumns: ["password"],
      rowCount: 1,
      columns: ["name", "password"],
      missingSecrets: false,
      createdAt: 1,
    })
    .run();
  db.insert(dbm.schema.schedules)
    .values({
      id: "sch1",
      workspaceId: ws.id,
      name: "Nightly",
      folderId: folder.id,
      datasetId: "ds1",
      datasetVersion: 1,
      cron: "0 3 * * *",
      options: {} as never,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const settings = await import("@/server/settings");
  settings.patchSettings({
    "history.limit": 123,
    "execution.defaultHeaders": [{ key: "X-Api-Key", value: "global-secret-jkl", enabled: true }],
  });
  // Data that is deliberately not part of a backup.
  repo.addHistory({
    workspaceId: ws.id,
    method: "GET",
    url: "https://example.test",
    request: {},
    response: null,
  });
});

afterAll(async () => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("restores a backup into a fresh database exactly", () => {
    const original = bk.createBackup(dbm.getDb(), { includeSecrets: true });
    expect(original.tables.workspaces).toHaveLength(1);
    expect(original.tables.requests).toHaveLength(1);
    expect(original.tables.appSettings.length).toBeGreaterThan(0);
    const target = fresh("restore-target");
    const summary = bk.restoreBackup(target.db, target.sqlite, roundTrip(original));
    expect(summary.workspaces).toBe(1);
    expect(summary.skippedSettings).toEqual([]);
    const restored = bk.createBackup(target.db, { includeSecrets: true });
    expect(stable(restored)).toBe(stable(original));
    // Structured values survive, including the gRPC definitions stored on the request.
    expect((restored.tables.requests[0].settings as { grpc: { method: string } }).grpc.method).toBe("Do");
    // History is not part of a backup.
    expect(target.db.select().from(dbm.schema.history).all()).toHaveLength(0);
    target.sqlite.close();
  });

  it("replaces whatever the target already holds", () => {
    const target = fresh("replace-target");
    target.db
      .insert(dbm.schema.workspaces)
      .values({ id: "old", name: "Old", createdAt: 1, updatedAt: 1 })
      .run();
    target.db
      .insert(dbm.schema.history)
      .values({ id: "h", workspaceId: "old", method: "GET", url: "x", request: {}, createdAt: 1 })
      .run();
    bk.restoreBackup(
      target.db,
      target.sqlite,
      roundTrip(bk.createBackup(dbm.getDb(), { includeSecrets: true })),
    );
    expect(
      target.db
        .select()
        .from(dbm.schema.workspaces)
        .all()
        .map((w) => w.name),
    ).toEqual(["Backup source"]);
    expect(target.db.select().from(dbm.schema.history).all()).toHaveLength(0);
    target.sqlite.close();
  });

  it("leaves secrets out when asked", () => {
    const scrubbed = bk.createBackup(dbm.getDb(), { includeSecrets: false });
    const text = JSON.stringify(scrubbed);
    for (const secret of [
      "folder-token-123",
      "folder-header-456",
      "request-password-789",
      "env-secret-abc",
      "collection-secret-def",
      "dataset-secret-ghi",
      "global-secret-jkl",
    ])
      expect(text, secret).not.toContain(secret);
    expect(scrubbed.secretsIncluded).toBe(false);
    // Everything else is kept.
    expect(text).toContain("staging.test");
    expect(text).toContain("X-Trace");
    expect(text).toContain("ann");
    const version = scrubbed.tables.datasetVersions[0] as {
      missingSecrets: boolean;
      secretColumns: string[];
    };
    expect(version.missingSecrets).toBe(true);
    expect(version.secretColumns).toEqual(["password"]);
    const full = JSON.stringify(bk.createBackup(dbm.getDb(), { includeSecrets: true }));
    expect(full).toContain("env-secret-abc");
  });

  it("rejects files that are not backups, and rolls back on bad data", () => {
    const target = fresh("atomic-target");
    target.db
      .insert(dbm.schema.workspaces)
      .values({ id: "keep", name: "Keep", createdAt: 1, updatedAt: 1 })
      .run();
    expect(() => bk.restoreBackup(target.db, target.sqlite, { hello: "world" })).toThrow(
      /not a Postbox backup/,
    );
    expect(() => bk.restoreBackup(target.db, target.sqlite, { postboxBackup: 2, tables: {} })).toThrow(
      /not a Postbox backup/,
    );
    const bad = roundTrip(bk.createBackup(dbm.getDb(), { includeSecrets: true }));
    bad.tables.requests[0].name = null; // NOT NULL column
    expect(() => bk.restoreBackup(target.db, target.sqlite, bad)).toThrow(/nothing was changed/);
    expect(
      target.db
        .select()
        .from(dbm.schema.workspaces)
        .all()
        .map((w) => w.id),
    ).toEqual(["keep"]);
    target.sqlite.close();
  });

  it("drops references to accounts that do not exist in the target", () => {
    const source = fresh("users-source");
    const now = Date.now();
    source.db
      .insert(dbm.schema.users)
      .values({ id: "u1", username: "ann", passwordHash: "x", createdAt: now, updatedAt: now })
      .run();
    source.db.insert(dbm.schema.workspaces).values({ id: "w", name: "W", createdAt: 1, updatedAt: 1 }).run();
    source.db
      .insert(dbm.schema.workspaceMembers)
      .values({ workspaceId: "w", userId: "u1", role: "editor", createdAt: 1 })
      .run();
    source.db
      .insert(dbm.schema.datasets)
      .values({
        id: "d",
        workspaceId: "w",
        name: "D",
        latestVersion: 1,
        createdBy: "u1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const backup = roundTrip(bk.createBackup(source.db, { includeSecrets: true }));

    const without = fresh("users-without");
    bk.restoreBackup(without.db, without.sqlite, backup);
    expect(without.db.select().from(dbm.schema.workspaceMembers).all()).toEqual([]);
    expect(without.db.select().from(dbm.schema.datasets).get()!.createdBy).toBeNull();

    const withUser = fresh("users-with");
    withUser.db
      .insert(dbm.schema.users)
      .values({ id: "u1", username: "ann", passwordHash: "x", createdAt: now, updatedAt: now })
      .run();
    bk.restoreBackup(withUser.db, withUser.sqlite, backup);
    expect(withUser.db.select().from(dbm.schema.workspaceMembers).all()).toHaveLength(1);
    expect(withUser.db.select().from(dbm.schema.datasets).get()!.createdBy).toBe("u1");
    for (const d of [source, without, withUser]) d.sqlite.close();
  });

  it("skips invalid saved settings and reports them", () => {
    const target = fresh("settings-target");
    const backup = roundTrip(bk.createBackup(dbm.getDb(), { includeSecrets: true }));
    backup.tables.appSettings.push({ key: "history.limit.bogus", value: 1, updatedAt: 1 });
    const summary = bk.restoreBackup(target.db, target.sqlite, backup);
    expect(summary.skippedSettings.length).toBe(1);
    expect(
      target.db
        .select()
        .from(dbm.schema.appSettings)
        .where(eq(dbm.schema.appSettings.key, "history.limit"))
        .get()!.value,
    ).toBe(123);
    target.sqlite.close();
  });
});

describe("database maintenance", () => {
  it("reports sizes and counts, compacts, and clears data by workspace", () => {
    const holder = fresh("maintenance");
    const { db, sqlite } = holder;
    db.insert(dbm.schema.workspaces)
      .values([
        { id: "a", name: "A", createdAt: 1, updatedAt: 1 },
        { id: "b", name: "B", createdAt: 1, updatedAt: 1 },
      ])
      .run();
    const big = "x".repeat(2000);
    for (let i = 0; i < 400; i++)
      db.insert(dbm.schema.history)
        .values({
          id: `h${i}`,
          workspaceId: i % 2 ? "a" : "b",
          method: "GET",
          url: big,
          request: { big },
          createdAt: i,
        })
        .run();
    db.insert(dbm.schema.cookies)
      .values({ id: "c", workspaceId: "a", domain: "d", name: "n", value: "v", createdAt: 1 })
      .run();
    const file = path.join(dir, "maintenance.db");
    expect(bk.databaseInfo(db, sqlite, file).counts).toMatchObject({
      workspaces: 2,
      history: 400,
      cookies: 1,
    });

    expect(bk.clearData(db, "history", ["a"])).toBe(200);
    expect(bk.databaseInfo(db, sqlite, file).counts.history).toBe(200);
    expect(bk.clearData(db, "history")).toBe(200);
    expect(bk.clearData(db, "cookies", ["b"])).toBe(0);
    expect(bk.clearData(db, "cookies")).toBe(1);

    const info = bk.databaseInfo(db, sqlite, file);
    expect(info.reclaimableBytes).toBeGreaterThan(100_000);
    const { before, after } = bk.compactDatabase(sqlite, file);
    expect(after).toBeLessThan(before);
    expect(bk.databaseInfo(db, sqlite, file).reclaimableBytes).toBe(0);
    sqlite.close();
  });
});

describe("history retention", () => {
  const day = 24 * 60 * 60 * 1000;
  const entry = (workspaceId: string) => ({
    workspaceId,
    method: "GET",
    url: "https://e.test",
    request: {},
    response: null,
  });

  it("honours the entry limit and the retention period", () => {
    const w = repo.createWorkspace("Retention");
    const db = dbm.getDb();
    for (let i = 0; i < 5; i++) repo.addHistory(entry(w.id), { limit: 3 });
    expect(repo.listHistory(w.id)).toHaveLength(3);

    // Age two entries past the retention period; the next insert purges them.
    const rows = db.select().from(dbm.schema.history).where(eq(dbm.schema.history.workspaceId, w.id)).all();
    for (const r of rows.slice(0, 2))
      db.update(dbm.schema.history)
        .set({ createdAt: Date.now() - 40 * day })
        .where(eq(dbm.schema.history.id, r.id))
        .run();
    repo.addHistory(entry(w.id), { limit: 50, retentionDays: 30 });
    expect(repo.listHistory(w.id)).toHaveLength(2);
    // Zero keeps everything.
    for (const r of repo.listHistory(w.id))
      db.update(dbm.schema.history).set({ createdAt: 1 }).where(eq(dbm.schema.history.id, r.id)).run();
    expect(repo.purgeExpiredHistory(0)).toBe(0);
    expect(repo.listHistory(w.id)).toHaveLength(2);
    expect(repo.purgeExpiredHistory(30)).toBeGreaterThanOrEqual(2);
    expect(repo.listHistory(w.id)).toHaveLength(0);
  });

  it("keeps exactly the newest entries even when many land in the same millisecond", () => {
    const w = repo.createWorkspace("Burst");
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      for (let i = 0; i < 10; i++) repo.addHistory(entry(w.id), { limit: 4 });
    } finally {
      Date.now = realNow;
    }
    expect(repo.listHistory(w.id)).toHaveLength(4);
  });

  it("reads limits from the saved settings and the environment", async () => {
    const { historySettings } = await import("@/server/execution-settings");
    expect(historySettings({} as unknown as NodeJS.ProcessEnv)).toMatchObject({
      limit: 123,
      retentionDays: 0,
      skipSecrets: false,
    });
    expect(historySettings({ HISTORY_LIMIT: "40" } as unknown as NodeJS.ProcessEnv).limit).toBe(40);
  });

  it("skips history for requests that use secrets when asked", async () => {
    const { runSingleRequest } = await import("@/server/context");
    const { defaultRequest } = await import("@/server/defaults");
    const settings = await import("@/server/settings");
    const w = repo.createWorkspace("Skip secrets");
    repo.replaceVariables(w.id, "global", null, [
      { key: "tok", value: "very-secret-token-987", type: "secret", enabled: true },
      { key: "region", value: "eu-west", type: "default", enabled: true },
    ]);
    const run = (headers: { key: string; value: string; enabled: boolean }[]) =>
      runSingleRequest({
        workspaceId: w.id,
        environmentId: null,
        folderId: null,
        requestId: null,
        request: defaultRequest({ url: `${base}/x`, headers }),
      });
    const withSecret = [{ key: "X-Token", value: "{{tok}}", enabled: true }];
    const without = [{ key: "X-Region", value: "{{region}}", enabled: true }];

    settings.patchSettings({ "history.skipSecrets": false });
    await run(withSecret);
    expect(repo.listHistory(w.id)).toHaveLength(1);

    settings.patchSettings({ "history.skipSecrets": true });
    const skipped = await run(withSecret);
    expect(skipped.historyId).toBeUndefined();
    expect(repo.listHistory(w.id)).toHaveLength(1);
    await run(without);
    expect(repo.listHistory(w.id)).toHaveLength(2);
    settings.patchSettings({ "history.skipSecrets": null });
  });
});
