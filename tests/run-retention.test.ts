import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-run-retention-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
let server: TestServer;
let repo: typeof import("@/server/repo");
let runs: typeof import("@/server/runs");
let retention: typeof import("@/server/run-retention");
let db: typeof import("@/server/db");

const DAY = 86_400_000;
const NOW = Date.now();

beforeAll(async () => {
  repo = await import("@/server/repo");
  runs = await import("@/server/runs");
  retention = await import("@/server/run-retention");
  db = await import("@/server/db");
  server = await startTestServer();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await server.close();
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function collection(name = "Retention") {
  const ws = repo.createWorkspace(name);
  const folder = repo.createFolder(ws.id, null, { name: "Collection" });
  repo.createRequest(ws.id, folder.id, { url: server.url + "/echo" });
  return { workspaceId: ws.id, folderId: folder.id };
}

let counter = 0;
type Status = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";
/** Insert a run with one stored result, started and finished at the given time. */
function insertRun(c: { workspaceId: string; folderId: string }, at: number, status: Status = "passed") {
  const id = `run-${++counter}`;
  const done = status !== "queued" && status !== "running";
  db.getDb()
    .insert(db.schema.runs)
    .values({
      id,
      workspaceId: c.workspaceId,
      folderId: c.folderId,
      name: "Collection",
      status,
      options: {} as never,
      startedAt: at,
      finishedAt: done ? at + 1000 : null,
    })
    .run();
  db.getDb()
    .insert(db.schema.runResults)
    .values({
      id: `${id}-result`,
      runId: id,
      iteration: 0,
      sequence: 0,
      name: "Echo",
      method: "GET",
      url: server.url + "/echo",
      tests: [],
      passed: true,
      responseBody: "stored body",
      createdAt: at,
    })
    .run();
  return id;
}

function insertLoadRun(c: { workspaceId: string; folderId: string }, at: number, status: Status = "passed") {
  const id = `load-${++counter}`;
  const done = status !== "queued" && status !== "running";
  db.getDb()
    .insert(db.schema.loadRuns)
    .values({
      id,
      workspaceId: c.workspaceId,
      folderId: c.folderId,
      name: "Load",
      status,
      profile: {} as never,
      startedAt: at,
      finishedAt: done ? at + 1000 : null,
    })
    .run();
  return id;
}

function runIds(workspaceId: string) {
  return (
    db
      .getSqlite()
      .prepare("SELECT id FROM runs WHERE workspace_id = ? ORDER BY started_at")
      .all(workspaceId) as {
      id: string;
    }[]
  ).map((r) => r.id);
}
function loadRunIds(workspaceId: string) {
  return (
    db
      .getSqlite()
      .prepare("SELECT id FROM load_runs WHERE workspace_id = ? ORDER BY started_at")
      .all(workspaceId) as { id: string }[]
  ).map((r) => r.id);
}
function resultCount(runId: string) {
  return (
    db.getSqlite().prepare("SELECT count(*) AS n FROM run_results WHERE run_id = ?").get(runId) as {
      n: number;
    }
  ).n;
}

describe("run retention", () => {
  it("removes runs past the retention period after the next run finishes, keeping new, active and last runs", async () => {
    vi.stubEnv("RUNS_RETENTION_DAYS", "1");
    vi.stubEnv("RUNS_MAX_PER_COLLECTION", "0");
    const c = collection();
    const old = insertRun(c, NOW - 3 * DAY);
    const oldFailed = insertRun(c, NOW - 2 * DAY, "failed");
    const scheduled = insertRun(c, NOW - 5 * DAY);
    const stuckRunning = insertRun(c, NOW - 4 * DAY, "running");
    const queued = insertRun(c, NOW - 4 * DAY, "queued");
    const recent = insertRun(c, NOW - DAY / 2);
    const oldLoad = insertLoadRun(c, NOW - 3 * DAY);
    const runningLoad = insertLoadRun(c, NOW - 3 * DAY, "running");
    const recentLoad = insertLoadRun(c, NOW - DAY / 2);
    db.getDb()
      .insert(db.schema.schedules)
      .values({
        id: `schedule-${++counter}`,
        workspaceId: c.workspaceId,
        name: "Nightly",
        folderId: c.folderId,
        cron: "0 3 * * *",
        options: {} as never,
        lastRunId: scheduled,
        lastRunAt: NOW - 5 * DAY,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(resultCount(old)).toBe(1);

    const { runId } = await runs.startRun({ ...c, environmentId: null });

    expect(runIds(c.workspaceId).sort()).toEqual([scheduled, stuckRunning, queued, recent, runId].sort());
    expect(resultCount(old)).toBe(0);
    expect(resultCount(oldFailed)).toBe(0);
    expect(resultCount(scheduled)).toBe(1);
    // Load tests follow the same rules (and are pruned when a collection run of the same folder finishes).
    expect(loadRunIds(c.workspaceId).sort()).toEqual([runningLoad, recentLoad].sort());
    expect(loadRunIds(c.workspaceId)).not.toContain(oldLoad);
  });

  it("keeps only the newest N finished runs per collection", async () => {
    vi.stubEnv("RUNS_RETENTION_DAYS", "0");
    vi.stubEnv("RUNS_MAX_PER_COLLECTION", "3");
    const c = collection();
    const other = collection("Other workspace");
    const ids = Array.from({ length: 6 }, (_, i) => insertRun(c, NOW - (10 - i) * DAY));
    const running = insertRun(c, NOW - 20 * DAY, "running");
    const otherIds = Array.from({ length: 5 }, (_, i) => insertRun(other, NOW - (10 - i) * DAY));

    const { runId } = await runs.startRun({ ...c, environmentId: null });

    // The finished run counts as the newest; the running row is never pruned and does not count.
    expect(runIds(c.workspaceId).sort()).toEqual([running, ids[4], ids[5], runId].sort());
    // Only the finishing run's collection is pruned at once; the hourly sweep covers the rest.
    expect(runIds(other.workspaceId)).toEqual(otherIds);
    expect(retention.pruneRuns({ retentionDays: 0, maxPerCollection: 3 }, NOW)).toMatchObject({ runs: 2 });
    expect(runIds(other.workspaceId)).toEqual(otherIds.slice(2));
  });

  it("applies the count limit per folder and to load tests", () => {
    const c = collection();
    const sub = repo.createFolder(c.workspaceId, c.folderId, { name: "Sub" });
    const top = Array.from({ length: 3 }, (_, i) => insertRun(c, NOW - (5 - i) * DAY));
    const nested = Array.from({ length: 3 }, (_, i) =>
      insertRun({ workspaceId: c.workspaceId, folderId: sub.id }, NOW - (5 - i) * DAY),
    );
    const loads = Array.from({ length: 3 }, (_, i) => insertLoadRun(c, NOW - (5 - i) * DAY));

    // A sweep over every collection; other tests' workspaces are pruned too, so only this one is checked.
    retention.pruneRuns({ retentionDays: 0, maxPerCollection: 2 }, NOW);
    expect(runIds(c.workspaceId).sort()).toEqual([...top.slice(1), ...nested.slice(1)].sort());
    expect(loadRunIds(c.workspaceId)).toEqual(loads.slice(1));
  });

  it("keeps everything when both limits are 0", () => {
    const c = collection();
    const ids = [insertRun(c, NOW - 400 * DAY), insertRun(c, NOW - 300 * DAY)];
    expect(retention.pruneRuns({ retentionDays: 0, maxPerCollection: 0 }, NOW)).toEqual({
      runs: 0,
      loadRuns: 0,
    });
    expect(runIds(c.workspaceId)).toEqual(ids);
  });

  it("reads limits from settings, with environment pins", () => {
    expect(retention.runRetentionSettings({})).toEqual({ retentionDays: 30, maxPerCollection: 200 });
    expect(
      retention.runRetentionSettings({ RUNS_RETENTION_DAYS: "7", RUNS_MAX_PER_COLLECTION: "50" }),
    ).toEqual({
      retentionDays: 7,
      maxPerCollection: 50,
    });
  });

  it("a schedule whose last run was pruned elsewhere still lists without a status", async () => {
    const c = collection();
    const scheduler = await import("@/server/scheduler");
    const schedule = scheduler.createSchedule({
      workspaceId: c.workspaceId,
      folderId: c.folderId,
      name: "S",
      cron: "0 3 * * *",
    });
    db.getSqlite().prepare("UPDATE schedules SET last_run_id = 'gone' WHERE id = ?").run(schedule.id);
    const listed = scheduler.listSchedules(c.workspaceId).find((s) => s.id === schedule.id);
    expect(listed).toMatchObject({ lastRunId: "gone", lastRunStatus: null });
  });
});
