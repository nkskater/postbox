/**
 * Self-hosted runners: enrol/revoke, job queue with leases and retries, and the runner-facing protocol.
 * See docs/private-runners.md. A job's `runId` is its idempotency key, so a result delivered twice, or
 * after a retry, is recorded once.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { exportPostmanCollection, exportPostmanEnvironment } from "@/core/convert/postman";
import { HostPatternSet, HostPolicyError } from "@/core/http/policy";
import {
  RUNNER_LEASE_MS,
  RUNNER_MAX_ATTEMPTS,
  RUNNER_ONLINE_MS,
  RUNNER_PENDING_MS,
  runnerResultSchema,
  type RunnerJob,
  type RunnerResult,
} from "@/core/runner-agent/protocol";
import type { MonitorMetrics } from "@/core/monitoring/model";
import { actorId, authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { recordMonitorSample } from "./monitors";

const { runners, runnerJobs, monitors, schedules } = schema;
type RunnerRow = typeof runners.$inferSelect;

const hosts = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .default([])
  .superRefine((list, ctx) => {
    try {
      new HostPatternSet(list, "hosts");
    } catch (error) {
      if (error instanceof HostPolicyError) ctx.addIssue({ code: "custom", message: error.message });
      else throw error;
    }
  });
const labels = z
  .array(z.string().trim().min(1).max(60))
  .max(20)
  .default([])
  .transform((list) => [...new Set(list)]);

export const runnerInput = z
  .object({
    workspaceId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    location: z.string().trim().max(100).default(""),
    labels,
    shareSecrets: z.boolean().default(false),
    allowHosts: hosts,
    denyHosts: hosts,
  })
  .strict();
export const runnerPatch = runnerInput.omit({ workspaceId: true }).partial();

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function view(row: RunnerRow, now = Date.now()) {
  const { tokenHash: _hash, ...rest } = row;
  const db = getDb();
  const count = (table: typeof monitors | typeof runnerJobs, where: ReturnType<typeof eq>) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(where)
      .get()?.n ?? 0;
  return {
    ...rest,
    status: row.revokedAt
      ? ("revoked" as const)
      : row.lastSeenAt && now - row.lastSeenAt <= RUNNER_ONLINE_MS
        ? ("online" as const)
        : ("offline" as const),
    monitorCount: count(monitors, eq(monitors.runnerId, row.id)),
    queued: count(
      runnerJobs,
      and(eq(runnerJobs.runnerId, row.id), inArray(runnerJobs.status, ["pending", "leased"]))!,
    ),
  };
}

function requireRunner(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(runners).where(eq(runners.id, id)).get();
  if (!row) throw new HttpError(404, "Runner not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}

export function listRunners(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(runners)
    .where(eq(runners.workspaceId, workspaceId))
    .orderBy(asc(runners.createdAt))
    .all()
    .map((row) => view(row));
}

export function getRunner(id: string) {
  return view(requireRunner(id));
}

/** Enrols a runner. The token is returned once; only its hash is stored. */
export function createRunner(raw: z.input<typeof runnerInput>) {
  const input = runnerInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  if (listRunners(input.workspaceId).filter((r) => r.status !== "revoked").length >= 25)
    throw new HttpError(429, "At most 25 active runners per workspace");
  const token = `pbr_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const row: RunnerRow = {
    id: newId(),
    ...input,
    tokenHash: hashToken(token),
    version: null,
    lastSeenAt: null,
    revokedAt: null,
    createdBy: actorId(),
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(runners).values(row).run();
  return { ...view(row), token };
}

export function updateRunner(id: string, raw: z.input<typeof runnerPatch>) {
  const current = requireRunner(id, "write");
  const patch = runnerPatch.parse(raw);
  if (current.revokedAt) throw new HttpError(409, "This runner is revoked");
  getDb()
    .update(runners)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(runners.id, id))
    .run();
  return getRunner(id);
}

/** Stops the runner from authenticating and fails what it was holding. Its monitors keep their assignment. */
export function revokeRunner(id: string) {
  const row = requireRunner(id, "write");
  if (row.revokedAt) return view(row);
  const now = Date.now();
  getDb().transaction(() => {
    getDb().update(runners).set({ revokedAt: now, updatedAt: now }).where(eq(runners.id, id)).run();
    for (const job of openJobs(id)) failJob(job, "Runner was revoked", now);
  });
  return getRunner(id);
}

export function deleteRunner(id: string) {
  const row = requireRunner(id, "write");
  const assigned = getDb().select({ id: monitors.id }).from(monitors).where(eq(monitors.runnerId, id)).get();
  if (assigned) throw new HttpError(409, "Move or delete the monitors assigned to this runner first");
  getDb().delete(runners).where(eq(runners.id, row.id)).run();
  return { ok: true };
}

/** Validates that a monitor may be assigned to this runner (same workspace, not revoked). */
export function assertAssignable(runnerId: string, workspaceId: string) {
  const row = getDb().select().from(runners).where(eq(runners.id, runnerId)).get();
  if (!row || row.workspaceId !== workspaceId)
    throw new HttpError(400, "Runner must belong to the monitor's workspace");
  if (row.revokedAt) throw new HttpError(400, "That runner is revoked");
}

// ------------------------------------------------------------------ queue

const openJobs = (runnerId: string) =>
  getDb()
    .select()
    .from(runnerJobs)
    .where(and(eq(runnerJobs.runnerId, runnerId), inArray(runnerJobs.status, ["pending", "leased"])))
    .all();

const EMPTY: MonitorMetrics = {
  requests: 0,
  available: 0,
  tests: 0,
  passedTests: 0,
  p95Ms: null,
  availability: 0,
  assertions: null,
  scriptErrors: 0,
};

/** Keeps the monitor's "last check" in step with what its runner reported. */
function markRun(monitorId: string, runId: string, at: number) {
  const monitor = getDb()
    .select({ scheduleId: monitors.scheduleId })
    .from(monitors)
    .where(eq(monitors.id, monitorId))
    .get();
  if (monitor)
    getDb()
      .update(schedules)
      .set({ lastRunId: runId, lastRunAt: at })
      .where(eq(schedules.id, monitor.scheduleId))
      .run();
}

/** Closes a job without a result: the check is recorded as an error so the monitor's state reflects it. */
function failJob(job: typeof runnerJobs.$inferSelect, reason: string, now: number) {
  getDb()
    .update(runnerJobs)
    .set({ status: "failed", error: reason, finishedAt: now, leaseExpiresAt: null })
    .where(eq(runnerJobs.id, job.id))
    .run();
  recordMonitorSample(job.monitorId, job.runId, EMPTY, "error", false, now, job.runnerId, [reason]);
  markRun(job.monitorId, job.runId, now);
}

/** Requeues jobs whose lease expired and fails those out of attempts or never picked up. */
export function sweepRunnerJobs(now = Date.now()) {
  const db = getDb();
  db.transaction(() => {
    for (const job of db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.status, "leased"), lt(runnerJobs.leaseExpiresAt, now)))
      .all()) {
      if (job.attempts >= RUNNER_MAX_ATTEMPTS)
        failJob(job, `Runner stopped responding after ${job.attempts} attempts`, now);
      else
        db.update(runnerJobs)
          .set({ status: "pending", leaseExpiresAt: null })
          .where(eq(runnerJobs.id, job.id))
          .run();
    }
    for (const job of db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.status, "pending"), lt(runnerJobs.createdAt, now - RUNNER_PENDING_MS)))
      .all())
      failJob(job, "Runner is offline: nobody picked up this check", now);
  });
}

let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    try {
      sweepRunnerJobs();
    } catch (error) {
      console.error(`[postbox] runner sweep failed: ${(error as Error).message}`);
    }
  }, 30_000);
  sweeper.unref();
}

/** The runner a monitor is assigned to, by schedule (null = runs on the server). */
export function runnerForSchedule(scheduleId: string): { monitorId: string; runnerId: string } | null {
  const row = getDb()
    .select({ id: monitors.id, runnerId: monitors.runnerId })
    .from(monitors)
    .where(eq(monitors.scheduleId, scheduleId))
    .get();
  return row?.runnerId ? { monitorId: row.id, runnerId: row.runnerId } : null;
}

/** Queues one check for the monitor's runner. Refuses to pile up behind an unfinished check. */
export function enqueueRunnerJob(monitorId: string, runnerId: string, now = Date.now()): { runId: string } {
  ensureSweeper();
  sweepRunnerJobs(now);
  const db = getDb();
  const runner = db.select().from(runners).where(eq(runners.id, runnerId)).get();
  const runId = newId();
  const job = {
    id: newId(),
    runId,
    monitorId,
    runnerId,
    status: "pending",
    attempts: 0,
    leaseExpiresAt: null,
    error: null,
    createdAt: now,
    finishedAt: null,
  };
  return db.transaction(() => {
    if (
      db
        .select({ id: runnerJobs.id })
        .from(runnerJobs)
        .where(and(eq(runnerJobs.monitorId, monitorId), inArray(runnerJobs.status, ["pending", "leased"])))
        .get()
    )
      throw new HttpError(409, "The previous check of this monitor has not finished on its runner");
    db.insert(runnerJobs).values(job).run();
    if (!runner || runner.revokedAt)
      failJob(
        job as typeof runnerJobs.$inferSelect,
        runner ? "Runner is revoked" : "Runner no longer exists",
        now,
      );
    return { runId };
  });
}

// ------------------------------------------------------------------ runner-facing

export function authenticateRunner(req: Request): RunnerRow {
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer (pbr_[A-Za-z0-9_-]{20,100})$/.exec(header)?.[1];
  if (!token) throw new HttpError(401, "Runner token required");
  const row = getDb()
    .select()
    .from(runners)
    .where(eq(runners.tokenHash, hashToken(token)))
    .get();
  if (!row) throw new HttpError(401, "Unknown runner token");
  if (row.revokedAt) throw new HttpError(403, "This runner has been revoked");
  return row;
}

function touch(runner: RunnerRow, version: string | null, now: number) {
  getDb()
    .update(runners)
    .set({ lastSeenAt: now, ...(version ? { version: version.slice(0, 40) } : {}) })
    .where(eq(runners.id, runner.id))
    .run();
}

function buildJob(job: typeof runnerJobs.$inferSelect, runner: RunnerRow): RunnerJob {
  const monitor = getDb().select().from(monitors).where(eq(monitors.id, job.monitorId)).get();
  const schedule =
    monitor && getDb().select().from(schedules).where(eq(schedules.id, monitor.scheduleId)).get();
  const tree = schedule && repo.getFolderTree(schedule.folderId);
  if (!monitor || !schedule || !tree) throw new HttpError(409, "The monitored collection no longer exists");
  const secrets = runner.shareSecrets;
  const variables = repo.getFolder(schedule.folderId)?.parentId
    ? []
    : repo.listVariables(monitor.workspaceId, "collection", schedule.folderId);
  const environment = schedule.environmentId ? repo.getEnvironment(schedule.environmentId) : null;
  return {
    jobId: job.id,
    runId: job.runId,
    monitorId: monitor.id,
    attempt: job.attempts,
    name: schedule.name,
    collection: exportPostmanCollection(tree, variables, {
      includeSecrets: secrets,
      includeCredentials: secrets,
    }),
    environment: environment
      ? exportPostmanEnvironment(environment.name, environment.variables, { includeSecrets: secrets })
      : null,
    globals: exportPostmanEnvironment("Globals", repo.listVariables(monitor.workspaceId, "global", null), {
      includeSecrets: secrets,
    }),
    limits: { timeoutMs: monitor.rules.timeoutMs, maxDurationMs: monitor.rules.maxDurationMs },
    policy: { allowHosts: runner.allowHosts, denyHosts: runner.denyHosts },
    leaseMs: RUNNER_LEASE_MS,
    secretsIncluded: secrets,
  };
}

/** Hands the oldest waiting job to the runner, or null. Calling this is also the runner's heartbeat. */
export function leaseJob(
  runner: RunnerRow,
  version: string | null = null,
  now = Date.now(),
): RunnerJob | null {
  touch(runner, version, now);
  sweepRunnerJobs(now);
  const db = getDb();
  return db.transaction(() => {
    const next = db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.runnerId, runner.id), eq(runnerJobs.status, "pending")))
      .orderBy(asc(runnerJobs.createdAt))
      .get();
    if (!next) return null;
    const leased = {
      ...next,
      status: "leased",
      attempts: next.attempts + 1,
      leaseExpiresAt: now + RUNNER_LEASE_MS,
    };
    try {
      const payload = buildJob(leased, runner);
      db.update(runnerJobs)
        .set({ status: "leased", attempts: leased.attempts, leaseExpiresAt: leased.leaseExpiresAt })
        .where(eq(runnerJobs.id, next.id))
        .run();
      return payload;
    } catch (error) {
      if (error instanceof HttpError) {
        failJob(next, error.message, now);
        return null;
      }
      throw error;
    }
  });
}

function ownedJob(runner: RunnerRow, jobId: string) {
  const job = getDb().select().from(runnerJobs).where(eq(runnerJobs.id, jobId)).get();
  if (!job || job.runnerId !== runner.id) throw new HttpError(404, "Job not found");
  return job;
}

/** Extends the lease. Tells the runner to stop when the job is no longer its own to finish. */
export function heartbeatJob(
  runner: RunnerRow,
  jobId: string,
  now = Date.now(),
): { ok: boolean; state: string } {
  touch(runner, null, now);
  const job = ownedJob(runner, jobId);
  if (job.status !== "leased") return { ok: false, state: job.status };
  getDb()
    .update(runnerJobs)
    .set({ leaseExpiresAt: now + RUNNER_LEASE_MS })
    .where(eq(runnerJobs.id, jobId))
    .run();
  return { ok: true, state: "leased" };
}

/** Records the result once. A repeat, or a result for a job already closed, is acknowledged and ignored. */
export function completeJob(
  runner: RunnerRow,
  jobId: string,
  raw: unknown,
  now = Date.now(),
): { recorded: boolean; duplicate: boolean } {
  touch(runner, null, now);
  const job = ownedJob(runner, jobId);
  const result: RunnerResult = runnerResultSchema.parse(raw);
  if (job.status === "done" || job.status === "failed") return { recorded: false, duplicate: true };
  getDb().transaction(() => {
    getDb()
      .update(runnerJobs)
      .set({ status: "done", finishedAt: now, leaseExpiresAt: null, error: result.error ?? null })
      .where(eq(runnerJobs.id, jobId))
      .run();
    recordMonitorSample(
      job.monitorId,
      job.runId,
      result.metrics,
      result.status,
      result.timedOut,
      result.finishedAt,
      runner.id,
    );
    markRun(job.monitorId, job.runId, result.finishedAt);
  });
  return { recorded: true, duplicate: false };
}

/** Removes finished jobs older than the monitor history needs. */
export function pruneRunnerJobs(before: number) {
  getDb()
    .delete(runnerJobs)
    .where(and(inArray(runnerJobs.status, ["done", "failed"]), lt(runnerJobs.finishedAt, before)))
    .run();
}
