import { eq } from "drizzle-orm";
import type { RunSummary } from "@/core/runner/runner";
import { currentCaller } from "./access-context";
import { authorize } from "./authorize";
import { getDb, schema } from "./db";

/** Detail reads use workspace membership, including viewers, rather than run authorship. */
export function includeRunDetails<T extends RunSummary & { id: string; workspaceId: string }>(run: T): T {
  authorize(currentCaller(), run.workspaceId, "read");
  const rows = getDb()
    .select({
      sequence: schema.runResults.sequence,
      iteration: schema.runResults.iteration,
      details: schema.runResults.executionDetails,
    })
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, run.id))
    .all();
  const details = new Map(rows.map((row) => [`${row.iteration}:${row.sequence}`, row.details]));
  return {
    ...run,
    results: run.results.map((result) => ({
      ...result,
      executionDetails: details.get(`${result.iteration}:${result.sequence}`) ?? undefined,
    })),
  };
}
