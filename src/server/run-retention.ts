import { resolveSettings } from "@/lib/settings/registry";
import { getSqlite } from "./db";
import { readSavedSettings } from "./settings";

export interface RunRetention {
  /** Remove finished runs older than this many days; 0 keeps them. */
  retentionDays: number;
  /** Keep only this many newest finished runs per collection or folder; 0 sets no limit. */
  maxPerCollection: number;
}

/** Limits a single collection or folder; without it every collection is pruned. */
export interface RunScope {
  workspaceId: string;
  folderId: string | null;
}

export function runRetentionSettings(env: Record<string, string | undefined> = process.env): RunRetention {
  const values = resolveSettings(readSavedSettings(), env).values;
  return {
    retentionDays: values["runs.retentionDays"] as number,
    maxPerCollection: values["runs.maxPerCollection"] as number,
  };
}

const DAY_MS = 86_400_000;
// Only finished rows are candidates: queued and running rows have no finish time yet.
const FINISHED = "finished_at IS NOT NULL AND status NOT IN ('queued', 'running')";
// The run a schedule (and the monitor built on it) shows as its last run stays.
const NOT_LAST_RUN = "id NOT IN (SELECT last_run_id FROM schedules WHERE last_run_id IS NOT NULL)";

function prune(table: "runs" | "load_runs", limits: RunRetention, at: number, scope?: RunScope): number {
  const db = getSqlite();
  const protect = table === "runs" ? ` AND ${NOT_LAST_RUN}` : "";
  const where = scope ? " AND workspace_id = @workspaceId AND folder_id IS @folderId" : "";
  const params = scope ? { workspaceId: scope.workspaceId, folderId: scope.folderId } : {};
  let removed = 0;
  // Results, run comparisons and other dependents follow through ON DELETE CASCADE.
  db.transaction(() => {
    if (limits.retentionDays > 0) {
      removed += db
        .prepare(`DELETE FROM ${table} WHERE ${FINISHED}${protect}${where} AND finished_at < @cutoff`)
        .run({ ...params, cutoff: at - limits.retentionDays * DAY_MS }).changes;
    }
    if (limits.maxPerCollection > 0) {
      removed += db
        .prepare(
          `DELETE FROM ${table} WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY workspace_id, folder_id ORDER BY started_at DESC, id DESC
               ) AS position
               FROM ${table} WHERE ${FINISHED}${where}
             ) WHERE position > @keep
           )${protect}`,
        )
        .run({ ...params, keep: limits.maxPerCollection }).changes;
    }
  })();
  return removed;
}

/** Apply run retention to collection runs and load tests. Returns how many rows were removed. */
export function pruneRuns(
  limits: RunRetention,
  at = Date.now(),
  scope?: RunScope,
): { runs: number; loadRuns: number } {
  return { runs: prune("runs", limits, at, scope), loadRuns: prune("load_runs", limits, at, scope) };
}

/**
 * Called when a run or load test finishes: applies the current settings to its collection.
 * The periodic sweep covers every other collection. Retention never fails a run.
 */
export function pruneRunsAfterFinish(scope: RunScope, at = Date.now()) {
  try {
    pruneRuns(runRetentionSettings(), at, scope);
  } catch (error) {
    console.error("[postbox] run retention failed:", error instanceof Error ? error.message : error);
  }
}
