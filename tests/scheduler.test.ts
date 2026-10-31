import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { DEFAULT_RUN_OPTIONS } from "@/core/types";
import type { RunSummary } from "@/core/runner/runner";
import { startTestServer, type TestServer } from "./helpers/server";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-scheduler-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let scheduler: typeof import("@/server/scheduler");
let repo: typeof import("@/server/repo");
let runs: typeof import("@/server/runs");
let db: typeof import("@/server/db");
let routes: typeof import("@/app/api/schedules/route");
let item: typeof import("@/app/api/schedules/[id]/route");
let trigger: typeof import("@/app/api/schedules/[id]/run/route");
let server: TestServer;

beforeAll(async () => {
  scheduler = await import("@/server/scheduler");
  repo = await import("@/server/repo");
  runs = await import("@/server/runs");
  db = await import("@/server/db");
  routes = await import("@/app/api/schedules/route");
  item = await import("@/app/api/schedules/[id]/route");
  trigger = await import("@/app/api/schedules/[id]/run/route");
  server = await startTestServer();
});
afterEach(() => {
  scheduler.stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  scheduler.stopScheduler();
  await server.close();
  db.getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const workspace = repo.createWorkspace("Schedules");
  const folder = repo.createFolder(workspace.id, null, { name: "Collection" });
  return { name: "Weekdays", workspaceId: workspace.id, folderId: folder.id, cron: "0 9 * * 1-5" };
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown, id?: string, trigger = false) =>
  new Request(`http://localhost/api/schedules${id ? `/${id}${trigger ? "/run" : ""}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("scheduled runs", () => {
  it("validates cron expressions with future UTC occurrences", () => {
    for (const expression of ["* * * * *", "*/5 * * * * *", "0 9 * * 1-5"])
      expect(scheduler.validCron(expression)).toBe(true);
    for (const expression of ["", "not cron", "61 * * * *", "0 0 31 2 *", "2026-01-01T00:00:00"])
      expect(scheduler.validCron(expression)).toBe(false);
  });

  it("registers enabled jobs once, refreshes updates, and unregisters disabled/deleted jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const start = vi.spyOn(runs, "startRun").mockImplementation(async (input) => {
      input.onEvent?.({
        type: "start",
        name: "Cron",
        iterations: 1,
        total: 0,
        startedAt: Date.now(),
        runId: "cron-run",
      });
      return { runId: "cron-run", summary: {} as RunSummary };
    });
    const input = fixture();
    const schedule = scheduler.createSchedule({ ...input, cron: "* * * * * *" });
    expect(schedule.nextRunAt).toBe(Date.now() + 1000);
    scheduler.startScheduler();
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledTimes(2);
    scheduler.updateSchedule(schedule.id, { cron: "*/5 * * * * *" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(start).toHaveBeenCalledTimes(3);
    scheduler.updateSchedule(schedule.id, { enabled: false });
    expect(scheduler.listSchedules(input.workspaceId)[0].nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(start).toHaveBeenCalledTimes(3);
    scheduler.updateSchedule(schedule.id, { enabled: true });
    scheduler.deleteSchedule(schedule.id);
    await vi.advanceTimersByTimeAsync(10000);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("reloads persisted jobs on startup and isolates invalid legacy schedules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const start = vi
      .spyOn(runs, "startRun")
      .mockResolvedValue({ runId: "restored", summary: {} as RunSummary });
    const input = fixture();
    const good = scheduler.createSchedule({ ...input, cron: "* * * * * *" });
    const invalid = scheduler.createSchedule({ ...input, enabled: false });
    scheduler.stopScheduler();
    db.getDb()
      .update(db.schema.schedules)
      .set({ cron: "broken", enabled: true })
      .where(eq(db.schema.schedules.id, invalid.id))
      .run();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    scheduler.startScheduler();
    const rows = scheduler.listSchedules(input.workspaceId);
    expect(rows.find((r) => r.id === good.id)?.nextRunAt).not.toBeNull();
    expect(rows.find((r) => r.id === invalid.id)?.enabled).toBe(false);
    expect(log).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledOnce();
    scheduler.deleteSchedule(good.id);
    scheduler.deleteSchedule(invalid.id);
  });

  it("starts runs asynchronously, persists history/source and blocks manual/cron overlap until completion", async () => {
    const input = fixture();
    repo.createRequest(input.workspaceId, input.folderId, { url: `${server.url}/slow?ms=120` });
    const schedule = scheduler.createSchedule({ ...input, enabled: false });
    const response = await trigger.POST(request("POST", undefined, schedule.id, true), context(schedule.id));
    expect(response.status).toBe(202);
    const { runId } = await response.json();
    const current = scheduler.listSchedules(input.workspaceId)[0];
    expect(current).toMatchObject({ running: true, lastRunId: runId, lastRunStatus: "running" });
    expect(current.lastRunAt).toBeGreaterThan(0);
    expect(
      (await trigger.POST(request("POST", undefined, schedule.id, true), context(schedule.id))).status,
    ).toBe(409);
    await vi.waitFor(() =>
      expect(scheduler.listSchedules(input.workspaceId)[0]).toMatchObject({
        running: false,
        lastRunStatus: "passed",
      }),
    );
    expect(runs.getRunSummary(runId)?.results).toHaveLength(1);
    expect(db.getDb().select().from(db.schema.runs).where(eq(db.schema.runs.id, runId)).get()?.source).toBe(
      "schedule",
    );
    const again = await scheduler.runSchedule(schedule.id);
    expect(again.runId).not.toBe(runId);
    scheduler.deleteSchedule(schedule.id);
    await vi.waitFor(() => expect(runs.getRunSummary(again.runId)?.status).toBe("passed"));
  });

  it("shares the overlap lock with cron callbacks and releases it after failed starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    let finish!: (value: Awaited<ReturnType<typeof runs.startRun>>) => void;
    const start = vi.spyOn(runs, "startRun").mockImplementation((input) => {
      input.onEvent?.({
        type: "start",
        name: "Held",
        iterations: 1,
        total: 0,
        startedAt: Date.now(),
        runId: "held",
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const input = fixture();
    const schedule = scheduler.createSchedule({ ...input, cron: "* * * * * *" });
    await scheduler.runSchedule(schedule.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(start).toHaveBeenCalledOnce();
    await expect(scheduler.runSchedule(schedule.id)).rejects.toMatchObject({ status: 409 });
    finish({ runId: "held", summary: {} as RunSummary });
    await vi.advanceTimersByTimeAsync(0);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    start.mockRejectedValue(new Error("failed start"));
    await expect(scheduler.runSchedule(schedule.id)).rejects.toThrow("failed start");
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.listSchedules(input.workspaceId)[0].running).toBe(false);
    expect(log).toHaveBeenCalled();
    scheduler.deleteSchedule(schedule.id);
  });

  it("provides validated CRUD endpoints and enforces workspace relationships", async () => {
    const input = fixture();
    const other = fixture();
    const env = repo.createEnvironment(other.workspaceId, "Other environment");
    expect((await routes.POST(request("POST", { ...input, cron: "bad" }))).status).toBe(400);
    expect((await routes.POST(request("POST", { ...input, folderId: other.folderId }))).status).toBe(400);
    expect((await routes.POST(request("POST", { ...input, environmentId: env.id }))).status).toBe(400);
    expect((await routes.POST(request("POST", { ...input, options: { iterations: -1 } }))).status).toBe(400);
    const created = await routes.POST(request("POST", { ...input, options: { timeoutMs: 500 } }));
    expect(created.status).toBe(201);
    const schedule = await created.json();
    const updated = await item.PATCH(
      request(
        "PATCH",
        { name: "Edited", enabled: false, options: { timeoutMs: null, iterations: 2 } },
        schedule.id,
      ),
      context(schedule.id),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      name: "Edited",
      enabled: false,
      options: { iterations: 2 },
    });
    const list = await routes.GET(
      new Request(
        `http://localhost/api/schedules?workspaceId=${input.workspaceId}&folderId=${input.folderId}`,
      ),
    );
    const listed = await list.json();
    expect(listed).toHaveLength(1);
    expect(listed[0].options.timeoutMs).toBeUndefined();
    expect(
      (await item.PATCH(request("PATCH", { environmentId: env.id }, schedule.id), context(schedule.id)))
        .status,
    ).toBe(400);
    expect((await item.DELETE(request("DELETE", undefined, schedule.id), context(schedule.id))).status).toBe(
      200,
    );
    expect(
      (await trigger.POST(request("POST", undefined, schedule.id, true), context(schedule.id))).status,
    ).toBe(404);
    expect(
      (await item.PATCH(request("PATCH", { enabled: true }, schedule.id), context(schedule.id))).status,
    ).toBe(404);
    expect((await routes.GET(new Request("http://localhost/api/schedules"))).status).toBe(400);
  });

  it("disables schedules whose folder was deleted before a trigger", async () => {
    const input = fixture();
    const schedule = scheduler.createSchedule(input);
    repo.deleteFolder(input.folderId);
    await expect(scheduler.runSchedule(schedule.id)).rejects.toMatchObject({ status: 400 });
    expect(scheduler.listSchedules(input.workspaceId)[0]).toMatchObject({ enabled: false, nextRunAt: null });
    scheduler.deleteSchedule(schedule.id);
  });
  it("skips and logs a full-queue cron tick once, releases its lock and retries the next tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const input = fixture();
    const schedule = scheduler.createSchedule({ ...input, cron: "* * * * * *" });
    const previousActive = process.env.RUNS_MAX_ACTIVE;
    const previousQueued = process.env.RUNS_MAX_QUEUED;
    process.env.RUNS_MAX_ACTIVE = "1";
    process.env.RUNS_MAX_QUEUED = "0";
    const blocker = runs.reserveRun();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`schedule ${schedule.id} skipped: Run queue is full`),
      );
      expect(error).not.toHaveBeenCalled();
      expect(runs.listRuns(input.workspaceId)).toEqual([]);
      expect(scheduler.listSchedules(input.workspaceId)[0]).toMatchObject({
        enabled: true,
        running: false,
        lastRunAt: null,
        lastRunId: null,
      });
      expect(runs.runQueue.stats()).toMatchObject({ active: 1, queued: 0 });
      blocker.release();
      await vi.advanceTimersByTimeAsync(1000);
      const after = scheduler.listSchedules(input.workspaceId)[0];
      expect(after).toMatchObject({ running: false, lastRunStatus: "passed" });
      expect(after.lastRunId).toBeTruthy();
      expect(warning).toHaveBeenCalledOnce();
      expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      blocker.release();
      scheduler.deleteSchedule(schedule.id);
      if (previousActive === undefined) delete process.env.RUNS_MAX_ACTIVE;
      else process.env.RUNS_MAX_ACTIVE = previousActive;
      if (previousQueued === undefined) delete process.env.RUNS_MAX_QUEUED;
      else process.env.RUNS_MAX_QUEUED = previousQueued;
    }
  });
  it.each(["queued", "running"] as const)(
    "reports an interrupted %s schedule run as error after restart",
    (status) => {
      const input = fixture();
      const schedule = scheduler.createSchedule({ ...input, enabled: false });
      const runId = `interrupted-${schedule.id}`;
      try {
        db.getDb()
          .insert(db.schema.runs)
          .values({
            id: runId,
            workspaceId: input.workspaceId,
            folderId: input.folderId,
            name: "Interrupted",
            status,
            options: { ...DEFAULT_RUN_OPTIONS },
            iterations: 1,
            startedAt: Date.now(),
          })
          .run();
        db.getDb()
          .update(db.schema.schedules)
          .set({ lastRunId: runId })
          .where(eq(db.schema.schedules.id, schedule.id))
          .run();
        expect(scheduler.listSchedules(input.workspaceId)[0]).toMatchObject({
          running: false,
          lastRunStatus: "error",
        });
        expect(runs.getRunSummary(runId)?.status).toBe("error");
      } finally {
        scheduler.deleteSchedule(schedule.id);
      }
    },
  );
});
