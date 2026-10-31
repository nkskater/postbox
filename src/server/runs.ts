/**
 * Server-side collection runs: loads the tree and scopes from SQLite, runs the
 * core runner, persists results incrementally and applies variable changes.
 * Used by /api/runs, the scheduler and the MCP server.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DataTable, RunOptions } from "@/core/types";
import { DEFAULT_RUN_OPTIONS } from "@/core/types";
import { runCollection, type RunEvent, type RunResult, type RunSummary } from "@/core/runner/runner";
import { CookieJarStore } from "@/core/http/cookies";
import { getDb, schema } from "./db";
import * as repo from "./repo";
import {
  getPolicy,
  loadScopes,
  persistScopes,
  persistOAuth2Token,
  persistenceSecrets,
  savedRequestResolver,
} from "./context";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { redactStoredValue } from "@/core/variables/resolver";
import { executionSettings, runQueueLimits } from "./execution-settings";
import { RunQueue, type RunTicket } from "./run-queue";

const { runs, runResults } = schema;

const globalRuns = globalThis as unknown as {
  __postboxRunQueue?: RunQueue;
  __postboxActiveRuns?: Map<string, AbortController>;
};
/** Cancellation handles must be shared by every route bundle in this process. */
const active = (globalRuns.__postboxActiveRuns ??= new Map<string, AbortController>());

/** Process-wide admission queue shared by every run source. */
export const runQueue = (globalRuns.__postboxRunQueue ??= new RunQueue(() => runQueueLimits()));

/** Reserve a run slot up front; throws RunQueueFullError (429) when the queue is full. */
export function reserveRun(): RunTicket {
  return runQueue.reserve();
}

export type StartRunEvent = (RunEvent | { type: "queued"; position: number }) & { runId: string };

export interface StartRunInput {
  workspaceId: string;
  folderId: string;
  environmentId: string | null;
  options?: Partial<RunOptions>;
  data?: DataTable | null;
  selectedRequestIds?: string[] | null;
  source?: "manual" | "schedule" | "mcp" | "api";
  onEvent?: (e: StartRunEvent) => void;
  signal?: AbortSignal;
  /** A slot from reserveRun(); reserved here when omitted. Always released by startRun. */
  ticket?: RunTicket;
  /** Default true for existing callers. False returns counters with an empty results array. */
  retainResults?: boolean;
}

export async function startRun(input: StartRunInput): Promise<{ runId: string; summary: RunSummary }> {
  let ticket = input.ticket;
  let database: ReturnType<typeof getDb> | undefined;
  let persistedRunId: string | undefined;
  let inserted = false;
  let errorSecrets: string[] = [];
  let onAbort: (() => void) | undefined;

  try {
    const ctrl = new AbortController();
    onAbort = () => ctrl.abort();
    // Only cheap metadata is needed before admission; trees and scopes are loaded later.
    const folder = repo.requireFolderIn(input.workspaceId, input.folderId);
    ticket ??= reserveRun();
    const admission = ticket;
    const options: RunOptions = { ...DEFAULT_RUN_OPTIONS, ...input.options };
    const db = getDb();
    database = db;
    const runId = newId();
    persistedRunId = runId;
    const queued = admission.position > 0;

    db.insert(runs)
      .values({
        id: runId,
        createdBy: actorId(),
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        name: folder.name,
        status: queued ? "queued" : "running",
        options,
        environmentId: input.environmentId,
        iterations: options.iterations,
        source: input.source ?? "manual",
        startedAt: Date.now(),
      })
      .run();
    inserted = true;

    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) ctrl.abort();
    active.set(runId, ctrl);

    if (queued) {
      input.onEvent?.({ type: "queued", position: admission.position, runId });
      await new Promise<void>((resolve) => {
        const finish = () => {
          ctrl.signal.removeEventListener("abort", finish);
          resolve();
        };
        if (ctrl.signal.aborted) return finish();
        ctrl.signal.addEventListener("abort", finish, { once: true });
        admission.ready.then(finish, () => {
          ctrl.abort();
          finish();
        });
      });
    }
    if (ctrl.signal.aborted) {
      const now = Date.now();
      db.update(runs).set({ status: "cancelled", finishedAt: now }).where(eq(runs.id, runId)).run();
      const summary: RunSummary = {
        name: folder.name,
        status: "cancelled",
        iterations: options.iterations,
        totalRequests: 0,
        failedRequests: 0,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
        results: [],
      };
      const { results: _results, ...done } = summary;
      input.onEvent?.({ type: "done", summary: done, runId });
      return { runId, summary };
    }

    // Refresh all execution data after admission, including changes made while queued.
    const chain = repo.getFolderChain(input.folderId);
    const root = repo.getFolderTree(input.folderId);
    if (!root) throw new Error("Folder not found");
    const ancestors = chain.slice(0, -1);
    const ctx = loadScopes(input.workspaceId, input.environmentId, chain[0]?.id ?? input.folderId);
    errorSecrets = ctx.secrets;
    const jar = new CookieJarStore(repo.listCookies(input.workspaceId));
    db.update(runs)
      .set({ name: root.name, status: "running", startedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();

    const saveResult = (r: RunResult) =>
      db
        .insert(runResults)
        .values({
          id: newId(),
          runId,
          iteration: r.iteration,
          sequence: r.sequence,
          requestId: r.requestId,
          name: r.name,
          method: r.method,
          url: r.url,
          status: r.status,
          statusText: r.statusText,
          timeMs: r.timeMs,
          size: r.size,
          tests: r.tests,
          error: r.error,
          passed: r.passed,
          path: r.path,
          skipped: r.skipped,
          scriptErrors: r.scriptErrors,
          executionDetails: r.executionDetails ?? null,
          responseBody: r.responseBody ?? null,
          responseHeaders: r.responseHeaders ?? null,
          createdAt: Date.now(),
        })
        .run();

    const { summary, scopes } = await runCollection({
      root,
      resolveRequest: savedRequestResolver(
        input.workspaceId,
        input.environmentId,
        ctx.secrets,
        options.persistVariables !== false,
      ),
      ancestors,
      scopes: ctx.scopes,
      options,
      data: input.data,
      selectedRequestIds: input.selectedRequestIds,
      cookieJar: jar,
      policy: getPolicy(),
      secrets: ctx.secrets,
      oauth2CacheScope: input.workspaceId,
      ...executionSettings(),
      onExecution: (item, result) => {
        persistOAuth2Token(
          input.workspaceId,
          item.request,
          item.ancestors,
          result.oauth2Token,
          item.request.id,
        );
        const secrets = persistenceSecrets(ctx, result.scopes);
        ctx.secrets.splice(0, ctx.secrets.length, ...secrets);
      },
      signal: ctrl.signal,
      retainResults: input.retainResults,
      onEvent: (e) => {
        // Completion is published only after the final persistence below succeeds.
        if (e.type === "done") return;
        if (e.type === "result") saveResult(e.result);
        input.onEvent?.({ ...e, runId });
      },
    });
    if (options.persistVariables !== false) persistScopes(ctx, scopes);
    repo.saveCookies(input.workspaceId, jar.getChanges());
    db.update(runs)
      .set({
        status: summary.status,
        iterations: summary.iterations,
        totalRequests: summary.totalRequests,
        failedRequests: summary.failedRequests,
        totalTests: summary.totalTests,
        passedTests: summary.passedTests,
        failedTests: summary.failedTests,
        durationMs: summary.durationMs,
        finishedAt: summary.finishedAt,
      })
      .where(eq(runs.id, runId))
      .run();
    const { results: _results, ...done } = summary;
    input.onEvent?.({ type: "done", summary: done, runId });
    return { runId, summary };
  } catch (err) {
    if (inserted && database && persistedRunId) {
      try {
        database
          .update(runs)
          .set({
            status: "error",
            error: redactStoredValue(err instanceof Error ? err.message : String(err), errorSecrets),
            finishedAt: Date.now(),
          })
          .where(eq(runs.id, persistedRunId))
          .run();
      } catch {
        // Return the original failure even when its status cannot be persisted.
      }
    }
    throw err;
  } finally {
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    if (persistedRunId) active.delete(persistedRunId);
    ticket?.release();
  }
}

export function cancelRun(runId: string): boolean {
  const c = active.get(runId);
  c?.abort();
  return !!c;
}

/** A queued or running row without an active handle was interrupted (e.g. server restart). */
function effectiveStatus(id: string, status: string) {
  return (status === "running" || status === "queued") && !active.has(id) ? "error" : status;
}

export function listRuns(workspaceId: string, folderId?: string | null, limit = 50) {
  const rows = getDb()
    .select()
    .from(runs)
    .where(
      folderId
        ? and(eq(runs.workspaceId, workspaceId), eq(runs.folderId, folderId))
        : eq(runs.workspaceId, workspaceId),
    )
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({ ...r, status: effectiveStatus(r.id, r.status) as typeof r.status }));
}

/** Rebuild a full RunSummary (with results) from the database. */
export function getRunSummary(
  runId: string,
): (RunSummary & { id: string; folderId: string | null; workspaceId: string }) | null {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;
  const rows = db
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId))
    .orderBy(runResults.sequence)
    .all();
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    folderId: run.folderId,
    name: run.name,
    status: effectiveStatus(run.id, run.status) as RunSummary["status"],
    iterations: run.iterations,
    totalRequests: run.totalRequests || rows.length,
    failedRequests: run.failedRequests,
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    durationMs: run.durationMs,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    error: run.error ?? undefined,
    results: rows.map((r) => ({
      iteration: r.iteration,
      sequence: r.sequence,
      requestId: r.requestId ?? "",
      name: r.name,
      path: r.path,
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      timeMs: r.timeMs,
      size: r.size,
      tests: r.tests,
      scriptErrors: r.scriptErrors,
      error: r.error,
      passed: r.passed,
      skipped: r.skipped,
      responseBody: r.responseBody ?? undefined,
      responseHeaders: r.responseHeaders ?? undefined,
    })),
  };
}

export function deleteRun(runId: string) {
  getDb().delete(runs).where(eq(runs.id, runId)).run();
}
