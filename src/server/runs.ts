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
import { getPolicy, loadScopes, persistScopes, persistOAuth2Token, persistenceSecrets } from "./context";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { redactStoredValue } from "@/core/variables/resolver";

const { runs, runResults } = schema;

/** Cancellation handles for runs in progress (this process only). */
const active = new Map<string, AbortController>();

export interface StartRunInput {
  workspaceId: string;
  folderId: string;
  environmentId: string | null;
  options?: Partial<RunOptions>;
  data?: DataTable | null;
  selectedRequestIds?: string[] | null;
  source?: "manual" | "schedule" | "mcp" | "api";
  onEvent?: (e: RunEvent & { runId: string }) => void;
  signal?: AbortSignal;
  /** Default true for existing callers. False returns counters with an empty results array. */
  retainResults?: boolean;
}

export async function startRun(input: StartRunInput): Promise<{ runId: string; summary: RunSummary }> {
  repo.requireFolderIn(input.workspaceId, input.folderId);
  const tree = repo.getFolderTree(input.folderId);
  if (!tree) throw new Error("Folder not found");
  const chain = repo.getFolderChain(input.folderId);
  const ancestors = chain.slice(0, -1);
  const collectionId = chain[0]?.id ?? input.folderId;
  const options: RunOptions = { ...DEFAULT_RUN_OPTIONS, ...input.options };
  const ctx = loadScopes(input.workspaceId, input.environmentId, collectionId);
  const jar = new CookieJarStore(repo.listCookies(input.workspaceId));
  const db = getDb();
  const runId = newId();
  const ctrl = new AbortController();

  db.insert(runs)
    .values({
      id: runId,
      createdBy: actorId(),
      workspaceId: input.workspaceId,
      folderId: input.folderId,
      name: tree.name,
      status: "running",
      options,
      environmentId: input.environmentId,
      iterations: options.iterations,
      source: input.source ?? "manual",
      startedAt: Date.now(),
    })
    .run();

  const onAbort = () => ctrl.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) ctrl.abort();
  active.set(runId, ctrl);

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
        responseBody: r.responseBody ?? null,
        responseHeaders: r.responseHeaders ?? null,
        createdAt: Date.now(),
      })
      .run();

  try {
    const { summary, scopes } = await runCollection({
      root: tree,
      ancestors,
      scopes: ctx.scopes,
      options,
      data: input.data,
      selectedRequestIds: input.selectedRequestIds,
      cookieJar: jar,
      policy: getPolicy(),
      secrets: ctx.secrets,
      oauth2CacheScope: input.workspaceId,
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
    db.update(runs)
      .set({
        status: "error",
        error: redactStoredValue((err as Error).message, ctx.secrets),
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, runId))
      .run();
    throw err;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    active.delete(runId);
  }
}

export function cancelRun(runId: string): boolean {
  const c = active.get(runId);
  c?.abort();
  return !!c;
}

export function listRuns(workspaceId: string, folderId?: string | null, limit = 50) {
  return getDb()
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
    // A "running" row without an active handle was interrupted (e.g. server restart).
    status: (run.status === "running" && !active.has(run.id) ? "error" : run.status) as RunSummary["status"],
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
