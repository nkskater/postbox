/**
 * Server-side load tests: admission through the shared run queue, quotas, the sandboxed core runner, and storage of
 * the outcome. Variables a test's scripts change are never persisted, and each virtual user has its own copy.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { profileSchema, type LoadProfile } from "@/core/load/profile";
import { LoadConfigError, runLoad, type LoadEvent } from "@/core/load/runner";
import { thresholdsSchema, type Threshold } from "@/core/load/thresholds";
import { redactStoredValue } from "@/core/variables/resolver";
import type { DataTable, DatasetRef } from "@/core/types";
import { getDb, schema } from "./db";
import * as repo from "./repo";
import { getPolicy, loadScopes, savedRequestResolver } from "./context";
import { requireDatasetRef, resolveDataset } from "./datasets";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { HttpError, notFound } from "./errors";
import { executionSettings, loadLimits } from "./execution-settings";
import { moduleSnapshot } from "./script-packages";
import { assertHeadroom, assertStorage, reserveUsage } from "./usage";
import { emitEvent } from "./webhooks";
import { isActive, recordRunUsage, reserveRun, trackActive, untrackActive } from "./runs";
import type { RunTicket } from "./run-queue";

const { loadRuns } = schema;

export const loadTestSchema = z.object({
  workspaceId: z.string().min(1),
  folderId: z.string().min(1),
  environmentId: z.string().nullish(),
  profile: profileSchema,
  thresholds: thresholdsSchema.optional(),
  thinkMs: z.number().int().min(0).max(60_000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  verifySsl: z.boolean().optional(),
  selectedRequestIds: z.array(z.string()).max(1000).nullish(),
  dataset: z.object({ id: z.string(), version: z.number().int().nullish() }).nullish(),
});
export type LoadTestInput = z.input<typeof loadTestSchema>;

export type StartLoadEvent = (LoadEvent | { type: "queued"; position: number }) & { runId: string };

/** Admit a test before the response turns into a stream: 429 when the queue is full, 400 for a profile over the ceilings. */
export function admitLoadTest(raw: LoadTestInput): {
  input: z.output<typeof loadTestSchema>;
  ticket: RunTicket;
} {
  const input = loadTestSchema.parse(raw);
  repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  if (input.dataset) requireDatasetRef(input.workspaceId, input.dataset as DatasetRef, { runnable: true });
  const limits = loadLimits();
  try {
    // Throws before anything is stored.
    checkLimits(input.profile, limits);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return { input, ticket: reserveRun() };
}

function checkLimits(profile: LoadProfile, limits: ReturnType<typeof loadLimits>) {
  // The core refuses too, but admission should fail fast and without queueing.
  const problems: string[] = [];
  const peak =
    profile.type === "constant"
      ? profile.vus
      : profile.type === "spike"
        ? profile.spikeVus
        : Math.max(profile.startVus, ...profile.stages.map((s) => s.target));
  const duration =
    profile.type === "ramp" ? profile.stages.reduce((n, s) => n + s.durationSec, 0) : profile.durationSec;
  if (peak > limits.maxVus)
    problems.push(`The profile needs ${peak} virtual users; the limit is ${limits.maxVus}`);
  if (duration > limits.maxDurationSec)
    problems.push(`The profile runs ${duration} s; the limit is ${limits.maxDurationSec} s`);
  if (problems.length) throw new LoadConfigError(problems.join(". "));
}

const LOAD_EVENTS = {
  passed: "load.passed",
  failed: "load.failed",
  cancelled: "load.cancelled",
  error: "load.error",
} as const;

export async function startLoadTest(
  admitted: { input: z.output<typeof loadTestSchema>; ticket: RunTicket },
  opts: {
    source?: "manual" | "api" | "mcp";
    onEvent?: (e: StartLoadEvent) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ runId: string; status: string }> {
  const { input, ticket } = admitted;
  const runId = newId();
  const db = getDb();
  let inserted = false;
  let secrets: string[] = [];
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  try {
    const folder = repo.requireFolderIn(input.workspaceId, input.folderId);
    assertStorage(input.workspaceId);
    assertHeadroom(input.workspaceId, "requests");
    assertHeadroom(input.workspaceId, "run_ms");
    reserveUsage({ workspaceId: input.workspaceId, metric: "runs", key: `load:${runId}`, enforce: true });
    const queued = ticket.position > 0;
    db.insert(loadRuns)
      .values({
        id: runId,
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        name: folder.name,
        status: queued ? "queued" : "running",
        profile: input.profile,
        thresholds: (input.thresholds ?? []) as Threshold[],
        thinkMs: input.thinkMs ?? 0,
        environmentId: input.environmentId ?? null,
        datasetId: input.dataset?.id ?? null,
        datasetVersion: input.dataset?.version ?? null,
        source: opts.source ?? "manual",
        createdBy: actorId(),
        startedAt: Date.now(),
      })
      .run();
    inserted = true;
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) ctrl.abort();
    trackActive(runId, ctrl);

    if (queued) {
      opts.onEvent?.({ type: "queued", position: ticket.position, runId });
      await new Promise<void>((resolve) => {
        const finish = () => {
          ctrl.signal.removeEventListener("abort", finish);
          resolve();
        };
        if (ctrl.signal.aborted) return finish();
        ctrl.signal.addEventListener("abort", finish, { once: true });
        ticket.ready.then(finish, () => {
          ctrl.abort();
          finish();
        });
      });
    }
    if (ctrl.signal.aborted) {
      db.update(loadRuns)
        .set({ status: "cancelled", finishedAt: Date.now() })
        .where(eq(loadRuns.id, runId))
        .run();
      return { runId, status: "cancelled" };
    }

    const chain = repo.getFolderChain(input.folderId);
    const root = repo.getFolderTree(input.folderId);
    if (!root) throw new Error("Folder not found");
    const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? input.folderId);
    let data: DataTable | null = null;
    if (input.dataset) {
      const dataset = resolveDataset(input.workspaceId, input.dataset as DatasetRef);
      data = dataset.table;
      ctx.secrets.push(...dataset.secrets);
      ctx.additionalSecrets = ctx.secrets;
      ctx.secretKeys.data = dataset.secretColumns;
      db.update(loadRuns).set({ datasetVersion: dataset.version }).where(eq(loadRuns.id, runId)).run();
    }
    secrets = ctx.secrets;
    db.update(loadRuns).set({ status: "running", startedAt: Date.now() }).where(eq(loadRuns.id, runId)).run();

    const result = await runLoad({
      root,
      ancestors: chain.slice(0, -1),
      resolveRequest: savedRequestResolver(
        input.workspaceId,
        input.environmentId ?? null,
        ctx.secrets,
        false,
      ),
      scopes: ctx.scopes,
      profile: input.profile,
      thresholds: input.thresholds,
      thinkMs: input.thinkMs,
      data,
      selectedRequestIds: input.selectedRequestIds,
      limits: loadLimits(),
      policy: getPolicy(),
      secrets: ctx.secrets,
      signal: ctrl.signal,
      timeoutMs: input.timeoutMs,
      verifySsl: input.verifySsl,
      oauth2CacheScope: input.workspaceId,
      scriptModules: moduleSnapshot(input.workspaceId),
      ...executionSettings(),
      onEvent: (e) => {
        if (e.type === "done") return;
        opts.onEvent?.({ ...e, runId });
      },
    });
    // Messages that quote a request or variable may carry secret values.
    const doc = redactStoredValue(
      {
        stoppedBy: result.stoppedBy,
        snapshot: result.snapshot,
        thresholds: result.thresholds,
        warnings: result.warnings,
      },
      secrets,
    );
    db.update(loadRuns)
      .set({ status: result.status, result: doc, finishedAt: result.finishedAt })
      .where(eq(loadRuns.id, runId))
      .run();
    recordRunUsage(input.workspaceId, runId, result.durationMs, result.snapshot.requests);
    emit(input.workspaceId, runId, input.folderId, result.status, {
      name: result.name,
      requests: result.snapshot.requests,
      errors: result.snapshot.errors,
      errorRate: result.snapshot.errorRate,
      rps: result.snapshot.rps,
      p95Ms: result.snapshot.latency.p95,
      peakVus: result.snapshot.peakVus,
      thresholdsFailed: result.thresholds.filter((t) => !t.passed).length,
      durationMs: result.durationMs,
    });
    opts.onEvent?.({ type: "done", result: { ...result, snapshot: doc.snapshot }, runId });
    return { runId, status: result.status };
  } catch (error) {
    if (inserted) {
      try {
        db.update(loadRuns)
          .set({
            status: "error",
            error: redactStoredValue(error instanceof Error ? error.message : String(error), secrets),
            finishedAt: Date.now(),
          })
          .where(eq(loadRuns.id, runId))
          .run();
        emit(input.workspaceId, runId, input.folderId, "error", {});
      } catch {
        /* report the original failure */
      }
    }
    if (error instanceof LoadConfigError) throw new HttpError(400, error.message);
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    untrackActive(runId);
    ticket.release();
  }
}

function emit(
  workspaceId: string,
  runId: string,
  folderId: string,
  status: string,
  details: Record<string, unknown>,
) {
  const type = LOAD_EVENTS[status as keyof typeof LOAD_EVENTS];
  if (type) emitEvent(workspaceId, type, { runId, folderId, status, ...details });
}

const effectiveStatus = (id: string, status: string) =>
  (status === "running" || status === "queued") && !isActive(id) ? "error" : status;

export function listLoadRuns(workspaceId: string, folderId?: string | null, limit = 50) {
  repo.requireWorkspace(workspaceId);
  return getDb()
    .select()
    .from(loadRuns)
    .where(
      folderId
        ? and(eq(loadRuns.workspaceId, workspaceId), eq(loadRuns.folderId, folderId))
        : eq(loadRuns.workspaceId, workspaceId),
    )
    .orderBy(desc(loadRuns.startedAt))
    .limit(limit)
    .all()
    .map(({ result, ...r }) => ({
      ...r,
      status: effectiveStatus(r.id, r.status),
      // The list carries the headline numbers; the full document, with the time series, comes from getLoadRun.
      summary: result
        ? {
            requests: result.snapshot.requests,
            errorRate: result.snapshot.errorRate,
            rps: result.snapshot.rps,
            p95: result.snapshot.latency.p95,
            peakVus: result.snapshot.peakVus,
            thresholdsFailed: result.thresholds.filter((t) => !t.passed).length,
          }
        : null,
    }));
}

export function getLoadRun(id: string) {
  const row = getDb().select().from(loadRuns).where(eq(loadRuns.id, id)).get();
  if (!row) throw notFound("Load run");
  return { ...row, status: effectiveStatus(row.id, row.status) };
}

export function deleteLoadRun(id: string) {
  const row = getDb().select().from(loadRuns).where(eq(loadRuns.id, id)).get();
  if (!row) throw notFound("Load run");
  if (isActive(id)) throw new HttpError(409, "Cancel the test before deleting it");
  getDb().delete(loadRuns).where(eq(loadRuns.id, id)).run();
}

/** Compare two finished tests: how each headline number changed from `base` to `head`. */
export function compareLoadRuns(workspaceId: string, baseId: string, headId: string) {
  const a = getLoadRun(baseId);
  const b = getLoadRun(headId);
  // Tests of other workspaces look like they do not exist.
  if (a.workspaceId !== workspaceId || b.workspaceId !== workspaceId) throw notFound("Load run");
  if (!a.result || !b.result) throw new HttpError(409, "Both tests must have finished");
  const x = a.result.snapshot;
  const y = b.result.snapshot;
  const change = (before: number, after: number) => ({
    before,
    after,
    delta: Math.round((after - before) * 10000) / 10000,
    percent: before ? Math.round(((after - before) / before) * 1000) / 10 : null,
  });
  return {
    base: { id: a.id, name: a.name, startedAt: a.startedAt, status: a.status },
    head: { id: b.id, name: b.name, startedAt: b.startedAt, status: b.status },
    metrics: {
      requests: change(x.requests, y.requests),
      rps: change(x.rps, y.rps),
      errorRate: change(x.errorRate, y.errorRate),
      avg: change(x.latency.avg, y.latency.avg),
      p50: change(x.latency.p50, y.latency.p50),
      p90: change(x.latency.p90, y.latency.p90),
      p95: change(x.latency.p95, y.latency.p95),
      p99: change(x.latency.p99, y.latency.p99),
      max: change(x.latency.max, y.latency.max),
    },
    byRequest: y.byRequest.map((r) => {
      const before = x.byRequest.find((o) => o.name === r.name);
      return {
        name: r.name,
        p95: before ? change(before.latency.p95, r.latency.p95) : null,
        errorRate: before ? change(before.errorRate, r.errorRate) : null,
      };
    }),
  };
}
