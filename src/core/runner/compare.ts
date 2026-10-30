import type { TestResult } from "../types";
import type { RunResult, RunSummary } from "./runner";

export type HistoricalRun = Omit<RunSummary, "status"> & {
  id: string;
  workspaceId: string;
  folderId: string | null;
  status: RunSummary["status"] | "running";
};
export type AssertionOutcome = "passed" | "failed" | "skipped";
export interface AssertionChange {
  name: string;
  occurrence: number;
  before: AssertionOutcome | null;
  after: AssertionOutcome | null;
  change: "new failure" | "recovered" | "added" | "removed" | "changed" | "unchanged";
}
export interface ExecutionSnapshot {
  name: string;
  method: string;
  status: number | null;
  timeMs: number | null;
  outcome: "passed" | "failed" | "skipped" | "error";
  body: string;
}
export interface ExecutionComparison {
  key: string;
  requestId: string;
  iteration: number;
  occurrence: number;
  presence: "matched" | "added" | "missing";
  before: ExecutionSnapshot | null;
  after: ExecutionSnapshot | null;
  statusChanged: boolean;
  outcomeChanged: boolean;
  timeDeltaMs: number | null;
  timeDeltaPercent: number | null;
  assertions: AssertionChange[];
}
export interface RunComparison {
  baseline: { id: string; startedAt: number; status: string; durationMs: number };
  candidate: { id: string; startedAt: number; status: string; durationMs: number };
  warnings: string[];
  executions: ExecutionComparison[];
  counts: {
    added: number;
    missing: number;
    statusChanges: number;
    outcomeChanges: number;
    newFailures: number;
    recovered: number;
  };
}

function assertionOutcome(test: TestResult): AssertionOutcome {
  return test.skipped ? "skipped" : test.passed ? "passed" : "failed";
}
function indexAssertions(tests: TestResult[]) {
  const counts = new Map<string, number>();
  return new Map(
    tests.map((test) => {
      const occurrence = (counts.get(test.name) ?? 0) + 1;
      counts.set(test.name, occurrence);
      return [JSON.stringify([test.name, occurrence]), { test, occurrence }] as const;
    }),
  );
}
function compareAssertions(before: TestResult[], after: TestResult[]): AssertionChange[] {
  const a = indexAssertions(before),
    b = indexAssertions(after);
  return [...new Set([...a.keys(), ...b.keys()])].map((key) => {
    const left = a.get(key),
      right = b.get(key);
    const from = left ? assertionOutcome(left.test) : null;
    const to = right ? assertionOutcome(right.test) : null;
    const change =
      to === "failed" && from !== "failed"
        ? "new failure"
        : from === "failed" && to === "passed"
          ? "recovered"
          : from === null
            ? "added"
            : to === null
              ? "removed"
              : from === to
                ? "unchanged"
                : "changed";
    return {
      name: (right ?? left)!.test.name,
      occurrence: (right ?? left)!.occurrence,
      before: from,
      after: to,
      change,
    };
  });
}

/** Historical rows have no complete-body or redaction metadata; never imply a full body diff. */
export function bodyAvailability(result: RunResult): string {
  if (result.responseBody === undefined) return "Unavailable (not retained or binary)";
  if (result.responseBody.includes("********")) return "Redaction marker present; truncation unknown";
  if (result.size != null && new TextEncoder().encode(result.responseBody).length < result.size)
    return "Truncated preview";
  return "Stored preview; truncation/redaction metadata unavailable";
}
function snapshot(result: RunResult): ExecutionSnapshot {
  return {
    name: result.name,
    method: result.method,
    status: result.status,
    timeMs: result.timeMs,
    outcome: result.skipped
      ? "skipped"
      : result.error || result.scriptErrors.length
        ? "error"
        : result.passed
          ? "passed"
          : "failed",
    body: bodyAvailability(result),
  };
}
function indexExecutions(run: HistoricalRun) {
  const counts = new Map<string, number>();
  return new Map(
    [...run.results]
      .sort((a, b) => a.sequence - b.sequence)
      .map((result, index) => {
        const identity = JSON.stringify([result.requestId, result.iteration]);
        const occurrence = (counts.get(identity) ?? 0) + 1;
        counts.set(identity, occurrence);
        // Deleted requests can lose their database ID. Do not match these by name or empty ID.
        const key = result.requestId
          ? JSON.stringify([result.requestId, result.iteration, occurrence])
          : JSON.stringify(["unidentified", run.id, index]);
        return [key, { result, occurrence }] as const;
      }),
  );
}

/** Compare saved evidence only. No executor, network, database, or original secret values are used. */
export function compareRuns(baseline: HistoricalRun, candidate: HistoricalRun): RunComparison {
  if (baseline.id === candidate.id) throw new Error("Choose two different runs");
  if (
    baseline.workspaceId !== candidate.workspaceId ||
    !baseline.folderId ||
    baseline.folderId !== candidate.folderId
  )
    throw new Error("Runs must belong to the same workspace and collection or folder");
  const warnings: string[] = [];
  for (const [label, run] of [
    ["Baseline", baseline],
    ["Candidate", candidate],
  ] as const) {
    if (["running", "cancelled", "error"].includes(run.status))
      warnings.push(`${label} is ${run.status}; added/missing executions may reflect an incomplete run.`);
    if (run.results.length < run.totalRequests)
      warnings.push(
        `${label} has ${run.results.length} retained executions out of ${run.totalRequests}; missing results are not proof that a request was removed.`,
      );
    if (run.results.some((r) => !r.requestId))
      warnings.push(`${label} contains executions without request IDs; these cannot be matched reliably.`);
  }
  const a = indexExecutions(baseline),
    b = indexExecutions(candidate);
  const executions: ExecutionComparison[] = [...new Set([...a.keys(), ...b.keys()])].map((key) => {
    const left = a.get(key),
      right = b.get(key);
    const before = left ? snapshot(left.result) : null,
      after = right ? snapshot(right.result) : null;
    const result = (right ?? left)!.result;
    const timeDeltaMs = before?.timeMs != null && after?.timeMs != null ? after.timeMs - before.timeMs : null;
    return {
      key,
      requestId: result.requestId,
      iteration: result.iteration,
      occurrence: (right ?? left)!.occurrence,
      presence: !before ? "added" : !after ? "missing" : "matched",
      before,
      after,
      statusChanged: !!before && !!after && before.status !== after.status,
      outcomeChanged: !!before && !!after && before.outcome !== after.outcome,
      timeDeltaMs,
      timeDeltaPercent: timeDeltaMs !== null && before?.timeMs ? (timeDeltaMs / before.timeMs) * 100 : null,
      assertions: compareAssertions(left?.result.tests ?? [], right?.result.tests ?? []),
    };
  });
  const header = (run: HistoricalRun) => ({
    id: run.id,
    startedAt: run.startedAt,
    status: run.status,
    durationMs: run.durationMs,
  });
  return {
    baseline: header(baseline),
    candidate: header(candidate),
    warnings,
    executions,
    counts: {
      added: executions.filter((e) => e.presence === "added").length,
      missing: executions.filter((e) => e.presence === "missing").length,
      statusChanges: executions.filter((e) => e.statusChanged).length,
      outcomeChanges: executions.filter((e) => e.outcomeChanged).length,
      newFailures: executions.flatMap((e) => e.assertions).filter((a) => a.change === "new failure").length,
      recovered: executions.flatMap((e) => e.assertions).filter((a) => a.change === "recovered").length,
    },
  };
}
