import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNNER_LEASE_MS,
  RUNNER_MAX_ATTEMPTS,
  RUNNER_PENDING_MS,
  type RunnerResult,
} from "@/core/runner-agent/protocol";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-runners-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const runners = await import("@/server/runners"),
  monitors = await import("@/server/monitors"),
  repo = await import("@/server/repo"),
  scheduler = await import("@/server/scheduler");
const { getDb, getSqlite, schema } = await import("@/server/db");
afterAll(() => {
  scheduler.stopScheduler();
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const asRunner = (token: string) =>
  runners.authenticateRunner(
    new Request("http://x/api/runner-agent/lease", { headers: { authorization: `Bearer ${token}` } }),
  );
const healthy = (at: number): RunnerResult => ({
  status: "passed",
  timedOut: false,
  startedAt: at - 50,
  finishedAt: at,
  metrics: {
    requests: 2,
    available: 2,
    tests: 2,
    passedTests: 2,
    p95Ms: 40,
    availability: 100,
    assertions: 100,
    scriptErrors: 0,
  },
});
const broken = (at: number): RunnerResult => ({
  ...healthy(at),
  status: "failed",
  metrics: {
    requests: 2,
    available: 0,
    tests: 2,
    passedTests: 0,
    p95Ms: 40,
    availability: 0,
    assertions: 0,
    scriptErrors: 0,
  },
});

function setup(options: Partial<Parameters<typeof runners.createRunner>[0]> = {}) {
  const ws = repo.createWorkspace(`Runner ws ${Math.random()}`);
  const folder = repo.createFolder(ws.id, null, { name: "Internal API" });
  repo.createRequest(ws.id, folder.id, { name: "Health", url: "http://intranet.test/health" });
  repo.replaceVariables(ws.id, "collection", folder.id, [
    { key: "apiKey", value: "collection-secret-value", type: "secret", enabled: true },
    { key: "host", value: "intranet.test", type: "default", enabled: true },
  ]);
  const runner = runners.createRunner({
    workspaceId: ws.id,
    name: "dc-east",
    location: "Frankfurt",
    labels: ["dc"],
    ...options,
  });
  const monitor = monitors.createMonitor({
    workspaceId: ws.id,
    folderId: folder.id,
    name: "Internal health",
    cron: "0 0 1 1 *",
    enabled: false,
    runnerId: runner.id,
    rules: { failAfter: 1, recoverAfter: 1 } as never,
  });
  return { ws, folder, runner, monitor, row: asRunner(runner.token) };
}

describe("enrolment and tokens", () => {
  it("shows the token once and authenticates by its hash", () => {
    const { runner, ws } = setup();
    expect(runner.token).toMatch(/^pbr_/);
    const listed = runners.listRunners(ws.id);
    expect(JSON.stringify(listed)).not.toContain(runner.token);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect(listed[0]).toMatchObject({
      name: "dc-east",
      location: "Frankfurt",
      status: "offline",
      monitorCount: 1,
    });
    expect(asRunner(runner.token).id).toBe(runner.id);
    expect(() => asRunner("pbr_" + "x".repeat(43))).toThrow(/Unknown runner token/);
    expect(() => runners.authenticateRunner(new Request("http://x"))).toThrow(/token required/);
  });

  it("rejects a revoked runner and fails what it held", () => {
    const { runner, monitor, row } = setup();
    const { runId } = runners.enqueueRunnerJob(monitor.id, runner.id);
    runners.leaseJob(row);
    runners.revokeRunner(runner.id);
    expect(() => asRunner(runner.token)).toThrow(/revoked/);
    const history = monitors.getMonitor(monitor.id).history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ runId, outcome: "failed", runnerId: runner.id });
    expect(history[0].reasons).toContain("Runner was revoked");
    expect(runners.getRunner(runner.id).status).toBe("revoked");
    expect(() => runners.updateRunner(runner.id, { name: "again" })).toThrow(/revoked/);
  });

  it("will not delete a runner that monitors still use, or assign across workspaces", () => {
    const { runner, monitor, ws } = setup();
    expect(() => runners.deleteRunner(runner.id)).toThrow(/Move or delete the monitors/);
    const other = repo.createWorkspace("Elsewhere");
    expect(() => runners.assertAssignable(runner.id, other.id)).toThrow(/same workspace|belong/);
    monitors.deleteMonitor(monitor.id);
    expect(runners.deleteRunner(runner.id)).toEqual({ ok: true });
    expect(runners.listRunners(ws.id)).toHaveLength(0);
  });

  it("validates host patterns and limits", () => {
    const ws = repo.createWorkspace("Patterns");
    expect(() =>
      runners.createRunner({ workspaceId: ws.id, name: "bad", allowHosts: ["not a host!"] }),
    ).toThrow();
    const ok = runners.createRunner({
      workspaceId: ws.id,
      name: "ok",
      allowHosts: ["*.corp.test", "10.0.0.0/8"],
    });
    expect(ok.allowHosts).toEqual(["*.corp.test", "10.0.0.0/8"]);
  });
});

describe("jobs", () => {
  it("queues a run for the runner instead of running on the server, and hands over the collection", async () => {
    const { runner, monitor, row } = setup();
    const { runId } = await monitors.runMonitor(monitor.id);
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(0);
    expect(runners.getRunner(runner.id).queued).toBe(1);
    const job = runners.leaseJob(row, "1.2.3")!;
    expect(job).toMatchObject({
      runId,
      monitorId: monitor.id,
      attempt: 1,
      name: "Internal health",
      leaseMs: RUNNER_LEASE_MS,
    });
    expect(JSON.stringify(job.collection)).toContain("intranet.test/health");
    expect(runners.getRunner(runner.id)).toMatchObject({ version: "1.2.3", status: "online" });
    expect(runners.leaseJob(row)).toBeNull();
  });

  it("keeps secret values off the wire unless the runner may hold them", () => {
    const blank = setup();
    runners.enqueueRunnerJob(blank.monitor.id, blank.runner.id);
    const without = runners.leaseJob(blank.row)!;
    expect(without.secretsIncluded).toBe(false);
    expect(JSON.stringify(without)).not.toContain("collection-secret-value");
    const trusted = setup({ shareSecrets: true });
    runners.enqueueRunnerJob(trusted.monitor.id, trusted.runner.id);
    const withSecrets = runners.leaseJob(trusted.row)!;
    expect(withSecrets.secretsIncluded).toBe(true);
    expect(JSON.stringify(withSecrets)).toContain("collection-secret-value");
  });

  it("carries the per-runner host policy", () => {
    const s = setup({ allowHosts: ["*.corp.test"], denyHosts: ["169.254.169.254"] });
    runners.enqueueRunnerJob(s.monitor.id, s.runner.id);
    expect(runners.leaseJob(s.row)!.policy).toEqual({
      allowHosts: ["*.corp.test"],
      denyHosts: ["169.254.169.254"],
    });
  });

  it("records a result once, drives the monitor state and ignores duplicate delivery", () => {
    const { runner, monitor, row } = setup();
    const now = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, now);
    const job = runners.leaseJob(row, null, now)!;
    expect(runners.completeJob(row, job.jobId, broken(now + 10), now + 10)).toEqual({
      recorded: true,
      duplicate: false,
    });
    expect(runners.completeJob(row, job.jobId, broken(now + 10), now + 20)).toEqual({
      recorded: false,
      duplicate: true,
    });
    const value = monitors.getMonitor(monitor.id);
    expect(value.history).toHaveLength(1);
    expect(value.history[0]).toMatchObject({ runnerId: runner.id, outcome: "failed" });
    expect(value.state).toBe("incident");
    expect(value.incidents).toHaveLength(1);
    expect(value.runner).toMatchObject({ name: "dc-east", location: "Frankfurt" });
    expect(value.lastRunId).toBe(value.history[0].runId);
    expect(value.lastRunAt).toBe(now + 10);
    // Recovery on the next check.
    runners.enqueueRunnerJob(monitor.id, runner.id, now + 100);
    const next = runners.leaseJob(row, null, now + 100)!;
    runners.completeJob(row, next.jobId, healthy(now + 110), now + 110);
    expect(monitors.getMonitor(monitor.id).state).toBe("healthy");
  });

  it("rejects malformed results and other runners' jobs", () => {
    const a = setup();
    const b = setup();
    runners.enqueueRunnerJob(a.monitor.id, a.runner.id);
    const job = runners.leaseJob(a.row)!;
    expect(() => runners.completeJob(a.row, job.jobId, { status: "passed" })).toThrow();
    expect(() =>
      runners.completeJob(a.row, job.jobId, {
        ...healthy(Date.now()),
        metrics: { ...healthy(1).metrics, availability: 250 },
      }),
    ).toThrow();
    expect(() => runners.completeJob(b.row, job.jobId, healthy(Date.now()))).toThrow(/Job not found/);
    expect(monitors.getMonitor(a.monitor.id).history).toHaveLength(0);
  });

  it("refuses to queue a second check behind an unfinished one", () => {
    const { runner, monitor } = setup();
    runners.enqueueRunnerJob(monitor.id, runner.id);
    expect(() => runners.enqueueRunnerJob(monitor.id, runner.id)).toThrow(/previous check/);
  });
});

describe("leases, retries and offline runners", () => {
  it("extends the lease on heartbeat and requeues a job whose runner went silent", () => {
    const { runner, monitor, row } = setup();
    const t0 = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, t0);
    const first = runners.leaseJob(row, null, t0)!;
    expect(runners.heartbeatJob(row, first.jobId, t0 + 50_000)).toEqual({ ok: true, state: "leased" });
    // Still held at t0 + 100s because the heartbeat moved the lease to t0 + 110s.
    expect(runners.leaseJob(row, null, t0 + 100_000)).toBeNull();
    // Silent past the lease: the next lease call gives the same job again, as attempt 2.
    const retry = runners.leaseJob(row, null, t0 + 50_000 + RUNNER_LEASE_MS + 1)!;
    expect(retry).toMatchObject({ jobId: first.jobId, runId: first.runId, attempt: 2 });
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(0);
  });

  it("tells a runner to stop when its job was requeued, and still accepts its late result once", () => {
    const { runner, monitor, row } = setup();
    const t0 = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, t0);
    const job = runners.leaseJob(row, null, t0)!;
    runners.sweepRunnerJobs(t0 + RUNNER_LEASE_MS + 1);
    expect(runners.heartbeatJob(row, job.jobId, t0 + RUNNER_LEASE_MS + 2)).toEqual({
      ok: false,
      state: "pending",
    });
    expect(
      runners.completeJob(row, job.jobId, healthy(t0 + RUNNER_LEASE_MS + 3), t0 + RUNNER_LEASE_MS + 3)
        .recorded,
    ).toBe(true);
    expect(runners.leaseJob(row, null, t0 + RUNNER_LEASE_MS + 4)).toBeNull();
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(1);
  });

  it("gives up after the maximum attempts and records an error check", () => {
    const { runner, monitor, row } = setup();
    let now = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, now);
    for (let attempt = 1; attempt <= RUNNER_MAX_ATTEMPTS; attempt++) {
      expect(runners.leaseJob(row, null, now)!.attempt).toBe(attempt);
      now += RUNNER_LEASE_MS + 1;
    }
    runners.sweepRunnerJobs(now);
    const value = monitors.getMonitor(monitor.id);
    expect(value.history).toHaveLength(1);
    expect(value.history[0]).toMatchObject({ outcome: "failed", runnerId: runner.id });
    expect(value.history[0].reasons[0]).toMatch(/stopped responding after 3 attempts/);
    expect(runners.leaseJob(row, null, now)).toBeNull();
    // The monitor can run again.
    expect(() => runners.enqueueRunnerJob(monitor.id, runner.id, now)).not.toThrow();
  });

  it("records an offline runner as a failed check", () => {
    const { runner, monitor } = setup();
    const t0 = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, t0);
    runners.sweepRunnerJobs(t0 + RUNNER_PENDING_MS - 1);
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(0);
    runners.sweepRunnerJobs(t0 + RUNNER_PENDING_MS + 1);
    const value = monitors.getMonitor(monitor.id);
    expect(value.history[0].reasons[0]).toMatch(/Runner is offline/);
    expect(value.state).toBe("incident");
  });

  it("records a check immediately when the runner was revoked after assignment", async () => {
    const { runner, monitor } = setup();
    runners.revokeRunner(runner.id);
    await monitors.runMonitor(monitor.id);
    expect(monitors.getMonitor(monitor.id).history[0].reasons[0]).toBe("Runner is revoked");
  });

  it("deletes finished jobs after the retention window", () => {
    const { runner, monitor, row } = setup();
    const t0 = Date.now();
    runners.enqueueRunnerJob(monitor.id, runner.id, t0);
    const job = runners.leaseJob(row, null, t0)!;
    runners.completeJob(row, job.jobId, healthy(t0), t0);
    runners.pruneRunnerJobs(t0 + 1);
    expect(
      getDb()
        .select()
        .from(schema.runnerJobs)
        .all()
        .some((j) => j.id === job.jobId),
    ).toBe(false);
  });
});
