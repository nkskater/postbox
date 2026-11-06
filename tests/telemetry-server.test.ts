import { afterAll, beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { batch, span } from "./fixtures/telemetry/traffic";
import { telemetryConfig } from "@/core/telemetry/model";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-telemetry-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getDb, getSqlite, schema } = await import("@/server/db"),
  telemetry = await import("@/server/telemetry"),
  { telemetryIntake } = await import("@/server/telemetry-http"),
  { withCaller } = await import("@/server/access-context"),
  users = await import("@/server/users"),
  repo = await import("@/server/repo"),
  { setMember } = await import("@/server/authorize"),
  { createBackup, restoreBackup } = await import("@/server/backup");
const db = getDb(),
  now = Date.now(),
  config = telemetryConfig.parse({ name: "Checkout", serviceName: "checkout" });
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string, otherWs: string;
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
const asOwner = <T>(fn: () => T) => withCaller(caller(owner), fn);
const create = (extra: Partial<typeof config> = {}) =>
  asOwner(() => telemetry.createTelemetrySource({ workspaceId: ws, config: { ...config, ...extra } }));
const query = () => ({ from: now - 86400000, to: Date.now() + 120000 });
function request(token: string, raw: unknown = {}, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/telemetry/ingest/test/v1/traces", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(raw),
  });
}
beforeAll(async () => {
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  ws = asOwner(() => repo.createWorkspace("Telemetry")).id;
  otherWs = withCaller(caller(outsider), () => repo.createWorkspace("Private")).id;
  asOwner(() => setMember(ws, viewer.username, "viewer"));
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
describe("authenticated bounded telemetry intake", () => {
  it("creates disabled sources with one-time credentials and guards membership and revisions", () => {
    const c = create();
    expect(c.source.config.enabled).toBe(false);
    expect(c.token).toHaveLength(43);
    expect(JSON.stringify(asOwner(() => telemetry.listTelemetrySources(ws)))).not.toContain(c.token);
    expect(asOwner(() => telemetry.getTelemetrySource(c.source.id))).not.toHaveProperty("tokenHash");
    expect(() => withCaller(caller(outsider), () => telemetry.getTelemetrySource(c.source.id))).toThrow();
    expect(() =>
      withCaller(caller(viewer), () =>
        telemetry.saveTelemetrySource(c.source.id, { expectedRevision: 1, config }),
      ),
    ).toThrow();
    expect(() =>
      asOwner(() => telemetry.saveTelemetrySource(c.source.id, { expectedRevision: 2, config })),
    ).toThrow(/reload/);
    expect(() => telemetry.ingestTelemetry(c.source.id, c.token, {})).toThrow(/disabled/);
  });
  it("ingests idempotently, preserves attribution and never stores sensitive trace fields", () => {
    const c = create({ enabled: true }),
      raw = batch([span(1, now, 10), span(2, now, 100, 503)]);
    expect(telemetry.ingestTelemetry(c.source.id, c.token, raw)).toMatchObject({
      accepted: 2,
      duplicates: 0,
    });
    expect(telemetry.ingestTelemetry(c.source.id, c.token, raw)).toMatchObject({
      accepted: 0,
      duplicates: 2,
    });
    const result = asOwner(() => telemetry.getTelemetryMetrics(ws, { ...query(), sourceId: c.source.id }));
    expect(result).toMatchObject({ sampledRequests: 2, errorRate: 50, p95Ms: 100 });
    const detail = asOwner(() => telemetry.getTelemetryEndpoint(ws, result.endpoints[0].id, query()));
    expect(detail.failedSpans[0]).toMatchObject({ sourceId: c.source.id, sourceRevision: 1 });
    expect(JSON.stringify(db.select().from(schema.telemetryObservations).all())).not.toContain("SECRET");
    expect(withCaller(caller(viewer), () => telemetry.getTelemetryMetrics(ws, query())).sampledRequests).toBe(
      2,
    );
    expect(() => withCaller(caller(outsider), () => telemetry.getTelemetryMetrics(ws, query()))).toThrow();
    expect(
      withCaller(caller(outsider), () => telemetry.getTelemetryMetrics(otherWs, query())).sampledRequests,
    ).toBe(0);
  });
  it("rotates credentials, rejects old and app credentials, and enforces disable immediately", async () => {
    const c = create({ enabled: true }),
      rotated = asOwner(() => telemetry.rotateTelemetrySource(c.source.id, { expectedRevision: 1 }));
    expect((await telemetryIntake(request(c.token), c.source.id)).status).toBe(401);
    expect((await telemetryIntake(request("app-token"), c.source.id)).status).toBe(401);
    expect((await telemetryIntake(request(rotated.token), c.source.id)).status).toBe(200);
    asOwner(() => telemetry.saveTelemetrySource(c.source.id, { expectedRevision: 2, config }));
    expect((await telemetryIntake(request(rotated.token), c.source.id)).status).toBe(403);
  });
  it("supports gzip and partial success while rejecting malformed, unsupported and oversized exports", async () => {
    const c = create({ enabled: true });
    const body = gzipSync(JSON.stringify(batch([span(4), { ...span(), traceId: "bad" }])));
    const res = await telemetryIntake(
      new Request("http://localhost", {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.token}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
      }),
      c.source.id,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partialSuccess: { rejectedSpans: "1" } });
    expect(
      (await telemetryIntake(request(c.token, {}, { "content-type": "application/x-protobuf" }), c.source.id))
        .status,
    ).toBe(415);
    expect(
      (await telemetryIntake(request(c.token, {}, { "content-encoding": "br" }), c.source.id)).status,
    ).toBe(415);
    expect(
      (await telemetryIntake(request(c.token, {}, { "content-encoding": "gzip" }), c.source.id)).status,
    ).toBe(400);
    expect(
      (await telemetryIntake(request(c.token, {}, { "content-length": "2097153" }), c.source.id)).status,
    ).toBe(413);
    const bomb = gzipSync(" ".repeat(2097153));
    expect(
      (
        await telemetryIntake(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              authorization: `Bearer ${c.token}`,
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
            body: bomb,
          }),
          c.source.id,
        )
      ).status,
    ).toBe(413);
    expect((await telemetryIntake(request(c.token, null), c.source.id)).status).toBe(400);
  });
  it("retains the newest bounded observations, prunes on reads and records sampling outcomes", () => {
    const c = create({ enabled: true, maxObservations: 100, retentionDays: 1 });
    const counts = telemetry.ingestTelemetry(
      c.source.id,
      c.token,
      batch(Array.from({ length: 150 }, (_, i) => span(i + 1000, now - i * 1000))),
    );
    expect(counts).toMatchObject({ accepted: 150, evicted: 50 });
    expect(
      asOwner(() => telemetry.getTelemetryMetrics(ws, { ...query(), sourceId: c.source.id })).sampledRequests,
    ).toBe(100);
    db.update(schema.telemetryObservations)
      .set({ at: now - 2 * 86400000 })
      .where(eq(schema.telemetryObservations.sourceId, c.source.id))
      .run();
    expect(
      asOwner(() => telemetry.getTelemetryMetrics(ws, { ...query(), sourceId: c.source.id })).sampledRequests,
    ).toBe(0);
    const zero = create({ enabled: true, sampleRate: 0 });
    expect(telemetry.ingestTelemetry(zero.source.id, zero.token, batch([span()]))).toMatchObject({
      accepted: 0,
      sampledOut: 1,
    });
  });
  it("enforces a source rate window without treating duplicates or samples as invalid spans", async () => {
    const c = create({ enabled: true });
    for (let i = 0; i < 120; i++)
      expect((await telemetryIntake(request(c.token), c.source.id)).status).toBe(200);
    const res = await telemetryIntake(request(c.token), c.source.id);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("purges and deletes data and refuses readers' destructive operations", () => {
    const c = create({ enabled: true });
    telemetry.ingestTelemetry(c.source.id, c.token, batch([span()]));
    expect(() => withCaller(caller(viewer), () => telemetry.purgeTelemetrySource(c.source.id))).toThrow();
    expect(asOwner(() => telemetry.purgeTelemetrySource(c.source.id)).deleted).toBe(1);
    telemetry.ingestTelemetry(c.source.id, c.token, batch([span()]));
    asOwner(() => telemetry.deleteTelemetrySource(c.source.id));
    expect(
      db
        .select()
        .from(schema.telemetryObservations)
        .where(eq(schema.telemetryObservations.sourceId, c.source.id))
        .all(),
    ).toEqual([]);
    expect(() => telemetry.authenticateTelemetry(c.source.id, c.token)).toThrow();
  });
  it("caps workspace observations independently of per-source caps", () => {
    const created = Array.from({ length: 5 }, () => create({ enabled: true, maxObservations: 5000 }));
    for (const [index, c] of created.entries())
      for (let b = 0; b < 5; b++)
        telemetry.ingestTelemetry(
          c.source.id,
          c.token,
          batch(
            Array.from({ length: 1000 }, (_, i) =>
              span(index * 10000 + b * 1000 + i + 20000, now - b * 1000),
            ),
          ),
        );
    expect(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.telemetryObservations)
        .where(eq(schema.telemetryObservations.workspaceId, ws))
        .get()?.n,
    ).toBe(20000);
  });
  it("omits observations and credentials from backups and cannot re-enable old credentials on restore", () => {
    const c = create({ enabled: true });
    telemetry.ingestTelemetry(c.source.id, c.token, batch([span()]));
    for (const includeSecrets of [false, true]) {
      const backup = createBackup(db, { includeSecrets });
      expect(backup.tables).not.toHaveProperty("telemetryObservations");
      const saved = backup.tables.telemetrySources.find((s) => s.id === c.source.id)!;
      expect(saved.tokenHash).toBe("");
      expect(saved.config).toMatchObject({ enabled: false });
    }
    const backup = createBackup(db, { includeSecrets: true });
    const saved = backup.tables.telemetrySources.find((s) => s.id === c.source.id)!;
    saved.tokenHash = "a".repeat(64);
    saved.config = { ...config, enabled: true };
    restoreBackup(db, getSqlite(), backup);
    expect(asOwner(() => telemetry.getTelemetrySource(c.source.id))).toMatchObject({
      credentialConfigured: false,
      config: { enabled: false },
    });
    expect(() =>
      asOwner(() =>
        telemetry.saveTelemetrySource(c.source.id, {
          expectedRevision: 1,
          config: { ...config, enabled: true },
        }),
      ),
    ).toThrow(/Rotate/);
    expect(() => telemetry.authenticateTelemetry(c.source.id, c.token)).toThrow();
  });
});
