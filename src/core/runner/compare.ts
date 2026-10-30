/**
 * Pure comparison of two historical collection runs (baseline vs candidate).
 *
 * Matches executions by stable request identity (`requestId`, falling back to
 * `method + path + name` only for legacy rows without `requestId`), `iteration`,
 * and `occurrence` within that iteration (supporting repeated executions via
 * `pm.execution.setNextRequest()`).
 */
import type { RunResult, RunSummary } from "./runner";

export type BodyAvailability = "available" | "truncated" | "redacted" | "unavailable";

export type AssertionOutcome =
  | "regressed"
  | "recovered"
  | "still_failing"
  | "still_passing"
  | "added_passing"
  | "added_failing"
  | "removed"
  | "skipped";

export interface AssertionComparison {
  name: string;
  occurrence: number;
  outcome: AssertionOutcome;
  baselinePassed: boolean | null;
  candidatePassed: boolean | null;
  baselineSkipped: boolean;
  candidateSkipped: boolean;
  baselineError?: string;
  candidateError?: string;
}

export type ExecutionComparisonOutcome =
  | "regressed"
  | "recovered"
  | "changed"
  | "added"
  | "missing"
  | "unchanged";

export interface ExecutionComparison {
  key: string;
  requestId: string;
  iteration: number;
  occurrence: number;
  name: string;
  baselineName: string | null;
  candidateName: string | null;
  renamed: boolean;
  method: string;
  url: string;
  path: string;
  outcome: ExecutionComparisonOutcome;
  baseline: RunResult | null;
  candidate: RunResult | null;
  statusChanged: boolean;
  baselineStatus: number | null;
  candidateStatus: number | null;
  passChanged: boolean;
  skippedChanged: boolean;
  errorChanged: boolean;
  deltaTimeMs: number | null;
  assertions: AssertionComparison[];
  regressedAssertions: AssertionComparison[];
  recoveredAssertions: AssertionComparison[];
  baselineBodyState: BodyAvailability;
  candidateBodyState: BodyAvailability;
}

export interface RunEndpointMeta {
  id: string;
  name: string;
  status: RunSummary["status"];
  startedAt: number;
  finishedAt: number;
  iterations: number;
  totalRequests: number;
  failedRequests: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
  incomplete: boolean;
  error?: string;
}

export interface RunComparisonCounts {
  totalExecutions: number;
  regressedExecutions: number;
  recoveredExecutions: number;
  changedExecutions: number;
  addedExecutions: number;
  missingExecutions: number;
  unchangedExecutions: number;
  regressedAssertions: number;
  recoveredAssertions: number;
  statusChanges: number;
  renamedRequests: number;
}

export interface RunComparisonSummary {
  baseline: RunEndpointMeta;
  candidate: RunEndpointMeta;
  counts: RunComparisonCounts;
  deltaDurationMs: number;
  executions: ExecutionComparison[];
}

export type ComparableRun = RunSummary & {
  id?: string;
  workspaceId?: string;
  folderId?: string | null;
};

const DEFAULT_KEEP_BODY_BYTES = 16 * 1024;

/**
 * Determine whether a stored execution's response body is available, truncated,
 * redacted, or unavailable without requiring the full response body to be retained.
 */
export function describeBodyAvailability(
  result: RunResult | null | undefined,
  keepBodyBytes = DEFAULT_KEEP_BODY_BYTES,
): BodyAvailability {
  if (!result || result.responseBody === undefined || result.responseBody === null || result.responseBody === "") {
    return "unavailable";
  }
  if (result.responseBody.includes("********")) {
    return "redacted";
  }
  const byteLen = Buffer.byteLength(result.responseBody, "utf8");
  if ((result.size !== null && result.size > byteLen) || result.responseBody.length >= keepBodyBytes) {
    return "truncated";
  }
  return "available";
}

/**
 * Compute stable identity for a `RunResult`. Uses `requestId` when present so
 * renamed or moved requests still match across runs.
 */
export function executionIdentity(r: RunResult): string {
  const id = (r.requestId ?? "").trim();
  if (id) return `req:${id}`;
  return `fallback:${r.method.toUpperCase()}:${r.path}:${r.name}`;
}

function compareAssertions(
  baseResult: RunResult | null,
  candResult: RunResult | null,
): AssertionComparison[] {
  const baseTests = baseResult?.tests ?? [];
  const candTests = candResult?.tests ?? [];

  type IndexedTest = {
    name: string;
    occurrence: number;
    passed: boolean;
    skipped: boolean;
    error?: string;
    order: number;
  };

  const indexTests = (tests: RunResult["tests"]): Map<string, IndexedTest> => {
    const counts = new Map<string, number>();
    const map = new Map<string, IndexedTest>();
    tests.forEach((t, idx) => {
      const occ = counts.get(t.name) ?? 0;
      counts.set(t.name, occ + 1);
      map.set(`${t.name}::${occ}`, {
        name: t.name,
        occurrence: occ,
        passed: !!t.passed,
        skipped: !!t.skipped,
        error: t.error,
        order: idx,
      });
    });
    return map;
  };

  const baseMap = indexTests(baseTests);
  const candMap = indexTests(candTests);
  const allKeys = new Set<string>([...candMap.keys(), ...baseMap.keys()]);

  const orderedKeys = [...allKeys].sort((a, b) => {
    const ca = candMap.get(a);
    const cb = candMap.get(b);
    const ba = baseMap.get(a);
    const bb = baseMap.get(b);
    const ordA = ca?.order ?? ba?.order ?? 0;
    const ordB = cb?.order ?? bb?.order ?? 0;
    return ordA - ordB;
  });

  return orderedKeys.map((key) => {
    const b = baseMap.get(key);
    const c = candMap.get(key);
    const name = c?.name ?? b!.name;
    const occurrence = c?.occurrence ?? b!.occurrence;

    let outcome: AssertionOutcome;
    if (b && c) {
      if (b.skipped && c.skipped) {
        outcome = "skipped";
      } else if (c.skipped && !b.skipped) {
        outcome = b.passed ? "changed" in ({} as never) ? "skipped" : "skipped" : "skipped";
      } else if (!b.skipped && c.skipped) {
        outcome = "skipped";
      } else if (b.passed && !c.passed) {
        outcome = "regressed";
      } else if (!b.passed && c.passed) {
        outcome = "recovered";
      } else if (!b.passed && !c.passed) {
        outcome = "still_failing";
      } else {
        outcome = "still_passing";
      }
    } else if (!b && c) {
      if (c.skipped) outcome = "skipped";
      else outcome = c.passed ? "added_passing" : "added_failing";
    } else {
      outcome = "removed";
    }

    return {
      name,
      occurrence,
      outcome,
      baselinePassed: b ? b.passed : null,
      candidatePassed: c ? c.passed : null,
      baselineSkipped: b ? b.skipped : false,
      candidateSkipped: c ? c.skipped : false,
      baselineError: b?.error,
      candidateError: c?.error,
    };
  });
}

function classifyExecutionOutcome(
  base: RunResult | null,
  cand: RunResult | null,
  regressedAssertions: AssertionComparison[],
  recoveredAssertions: AssertionComparison[],
  statusChanged: boolean,
  skippedChanged: boolean,
  errorChanged: boolean,
  renamed: boolean,
): ExecutionComparisonOutcome {
  if (!base && cand) return "added";
  if (base && !cand) return "missing";
  if (!base || !cand) return "unchanged";

  const baseFailed = !base.skipped && !base.passed;
  const candFailed = !cand.skipped && !cand.passed;
  const baseHttpError = base.status !== null && base.status >= 400;
  const candHttpError = cand.status !== null && cand.status >= 400;

  // Regression: passed -> failed, new assertion regressions, new transport/script errors,
  // or HTTP status degraded from <400 to >=400 or null (network error).
  if (
    (!baseFailed && candFailed) ||
    regressedAssertions.length > 0 ||
    (!base.error && !!cand.error) ||
    (base.scriptErrors.length === 0 && cand.scriptErrors.length > 0) ||
    (!baseHttpError && base.status !== null && (candHttpError || (!cand.skipped && cand.status === null)))
  ) {
    return "regressed";
  }

  // Recovery: failed -> passed, assertion recoveries without new regressions,
  // or HTTP status recovered from >=400/ERR to <400.
  if (
    (baseFailed && !candFailed && !cand.skipped) ||
    recoveredAssertions.length > 0 ||
    ((baseHttpError || (!base.skipped && base.status === null)) &&
      cand.status !== null &&
      cand.status < 400 &&
      !candFailed)
  ) {
    return "recovered";
  }

  if (statusChanged || skippedChanged || errorChanged || renamed) {
    return "changed";
  }

  return "unchanged";
}

function toEndpointMeta(run: ComparableRun, fallbackId: string): RunEndpointMeta {
  const recordedCount = run.results.length;
  const incomplete =
    run.status === "cancelled" ||
    run.status === "error" ||
    (run.totalRequests > 0 && recordedCount < run.totalRequests);
  return {
    id: run.id ?? fallbackId,
    name: run.name,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    iterations: run.iterations,
    totalRequests: run.totalRequests,
    failedRequests: run.failedRequests,
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    durationMs: run.durationMs,
    incomplete,
    error: run.error,
  };
}

/**
 * Compare a baseline `RunSummary` and a candidate `RunSummary` without re-executing
 * any requests.
 */
export function compareRunSummaries(
  baselineRun: ComparableRun,
  candidateRun: ComparableRun,
): RunComparisonSummary {
  type IndexedExec = {
    key: string;
    identity: string;
    requestId: string;
    iteration: number;
    occurrence: number;
    result: RunResult;
    order: number;
  };

  const indexResults = (results: RunResult[]): Map<string, IndexedExec> => {
    const occCounter = new Map<string, number>();
    const map = new Map<string, IndexedExec>();
    const sorted = [...results].sort((a, b) => a.sequence - b.sequence);
    sorted.forEach((r, idx) => {
      const identity = executionIdentity(r);
      const iterKey = `${identity}#iter=${r.iteration}`;
      const occ = occCounter.get(iterKey) ?? 0;
      occCounter.set(iterKey, occ + 1);
      const key = `${iterKey}#occ=${occ}`;
      map.set(key, {
        key,
        identity,
        requestId: r.requestId,
        iteration: r.iteration,
        occurrence: occ,
        result: r,
        order: idx,
      });
    });
    return map;
  };

  const baseMap = indexResults(baselineRun.results);
  const candMap = indexResults(candidateRun.results);
  const allKeys = new Set<string>([...candMap.keys(), ...baseMap.keys()]);

  const sortedKeys = [...allKeys].sort((ka, kb) => {
    const ba = baseMap.get(ka);
    const ca = candMap.get(ka);
    const bb = baseMap.get(kb);
    const cb = candMap.get(kb);
    const iterA = ca?.iteration ?? ba!.iteration;
    const iterB = cb?.iteration ?? bb!.iteration;
    if (iterA !== iterB) return iterA - iterB;
    const seqA = ca?.result.sequence ?? ba!.result.sequence;
    const seqB = cb?.result.sequence ?? bb!.result.sequence;
    if (seqA !== seqB) return seqA - seqB;
    return (ba?.order ?? ca!.order) - (bb?.order ?? cb!.order);
  });

  const counts: RunComparisonCounts = {
    totalExecutions: sortedKeys.length,
    regressedExecutions: 0,
    recoveredExecutions: 0,
    changedExecutions: 0,
    addedExecutions: 0,
    missingExecutions: 0,
    unchangedExecutions: 0,
    regressedAssertions: 0,
    recoveredAssertions: 0,
    statusChanges: 0,
    renamedRequests: 0,
  };

  const executions: ExecutionComparison[] = sortedKeys.map((key) => {
    const bEntry = baseMap.get(key);
    const cEntry = candMap.get(key);
    const base = bEntry?.result ?? null;
    const cand = cEntry?.result ?? null;
    const primary = cand ?? base!;

    const baselineName = base ? base.name : null;
    const candidateName = cand ? cand.name : null;
    const renamed = base !== null && cand !== null && base.name !== cand.name;
    const statusChanged = base !== null && cand !== null && base.status !== cand.status;
    const passChanged = base !== null && cand !== null && base.passed !== cand.passed;
    const skippedChanged = base !== null && cand !== null && base.skipped !== cand.skipped;
    const errorChanged =
      base !== null &&
      cand !== null &&
      ((base.error ?? null) !== (cand.error ?? null) ||
        base.scriptErrors.length !== cand.scriptErrors.length);

    const deltaTimeMs =
      base?.timeMs !== null &&
      base?.timeMs !== undefined &&
      cand?.timeMs !== null &&
      cand?.timeMs !== undefined
        ? cand.timeMs - base.timeMs
        : null;

    const assertions = compareAssertions(base, cand);
    const regressedAssertions = assertions.filter(
      (a) => a.outcome === "regressed" || a.outcome === "added_failing",
    );
    const recoveredAssertions = assertions.filter((a) => a.outcome === "recovered");

    const outcome = classifyExecutionOutcome(
      base,
      cand,
      regressedAssertions,
      recoveredAssertions,
      statusChanged,
      skippedChanged,
      errorChanged,
      renamed,
    );

    if (outcome === "regressed") counts.regressedExecutions++;
    else if (outcome === "recovered") counts.recoveredExecutions++;
    else if (outcome === "changed") counts.changedExecutions++;
    else if (outcome === "added") counts.addedExecutions++;
    else if (outcome === "missing") counts.missingExecutions++;
    else counts.unchangedExecutions++;

    counts.regressedAssertions += regressedAssertions.length;
    counts.recoveredAssertions += recoveredAssertions.length;
    if (statusChanged) counts.statusChanges++;
    if (renamed) counts.renamedRequests++;

    return {
      key,
      requestId: primary.requestId,
      iteration: primary.iteration,
      occurrence: (cEntry ?? bEntry)!.occurrence,
      name: primary.name,
      baselineName,
      candidateName,
      renamed,
      method: primary.method,
      url: primary.url,
      path: primary.path,
      outcome,
      baseline: base,
      candidate: cand,
      statusChanged,
      baselineStatus: base ? base.status : null,
      candidateStatus: cand ? cand.status : null,
      passChanged,
      skippedChanged,
      errorChanged,
      deltaTimeMs,
      assertions,
      regressedAssertions,
      recoveredAssertions,
      baselineBodyState: describeBodyAvailability(base),
      candidateBodyState: describeBodyAvailability(cand),
    };
  });

  const baselineMeta = toEndpointMeta(baselineRun, "baseline");
  const candidateMeta = toEndpointMeta(candidateRun, "candidate");

  return {
    baseline: baselineMeta,
    candidate: candidateMeta,
    counts,
    deltaDurationMs: candidateMeta.durationMs - baselineMeta.durationMs,
    executions,
  };
}
