"use client";

import { useEffect, useRef, useState } from "react";
import { compareRuns, type HistoricalRun, type RunComparison as Comparison } from "@/core/runner/compare";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatMs } from "@/lib/format";

interface RunChoice {
  id: string;
  startedAt: number;
  status: string;
}
const timestamp = (time: number) => formatDateTime(time);
const signedMs = (value: number | null) =>
  value === null ? "Unavailable" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatMs(Math.abs(value))}`;

export function ComparisonResults({ comparison }: { comparison: Comparison }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {(["baseline", "candidate"] as const).map((role) => {
          const run = comparison[role];
          return (
            <div key={role} className="min-w-0 rounded border p-2">
              <div className="font-medium capitalize">
                {role}: {run.status}
              </div>
              <div>
                {timestamp(run.startedAt)} · {formatMs(run.durationMs)}
              </div>
              <div className="break-all font-mono text-[10px]">{run.id}</div>
            </div>
          );
        })}
      </div>
      {comparison.warnings.map((warning) => (
        <p key={warning} className="text-warning">
          {warning}
        </p>
      ))}
      <p className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Comparison totals">
        <span className="text-destructive">New assertion failures: {comparison.counts.newFailures}</span>
        <span className="text-success">Recovered assertions: {comparison.counts.recovered}</span>
        <span>Added executions: {comparison.counts.added}</span>
        <span>Missing executions: {comparison.counts.missing}</span>
        <span>Status changes: {comparison.counts.statusChanges}</span>
        <span>Outcome changes: {comparison.counts.outcomeChanges}</span>
      </p>
      <p className="text-muted-foreground">
        Timing deltas are candidate minus baseline. Assertions match by name and occurrence; renamed
        assertions appear as added/removed. Bodies are not compared. Added/missing executions can also reflect
        request selection, iteration counts, or stopping early.
      </p>
      {!comparison.executions.length && <p>No retained executions in either run.</p>}
      {comparison.executions.map((execution) => {
        const result = (execution.after ?? execution.before)!;
        const assertions = execution.assertions.filter((a) => a.change !== "unchanged");
        return (
          <details key={execution.key} className="rounded border p-2">
            <summary className="cursor-pointer space-x-2">
              <span className="font-medium">
                {result.method} {result.name}
              </span>
              <span>
                · iteration {execution.iteration + 1}, occurrence {execution.occurrence}
              </span>
              <span>· {execution.presence}</span>
              <span>
                · {execution.before?.outcome ?? "absent"} → {execution.after?.outcome ?? "absent"}
              </span>
              <span>
                · HTTP {execution.before?.status ?? "—"} → {execution.after?.status ?? "—"}
              </span>
              <span>
                · {signedMs(execution.timeDeltaMs)}{" "}
                {execution.timeDeltaPercent === null
                  ? ""
                  : `(${execution.timeDeltaPercent > 0 ? "+" : ""}${execution.timeDeltaPercent.toFixed(1)}%)`}
              </span>
              {assertions.length > 0 && <span>· {assertions.length} assertion changes</span>}
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p className="break-all font-mono text-[10px]">
                Request ID: {execution.requestId || "unavailable"}
              </p>
              {execution.before && execution.after && execution.before.name !== execution.after.name && (
                <p>
                  Renamed: {execution.before.name} → {execution.after.name}
                </p>
              )}
              <p>
                Baseline time: {formatMs(execution.before?.timeMs)}; candidate time:{" "}
                {formatMs(execution.after?.timeMs)}
              </p>
              <p>Baseline body: {execution.before?.body ?? "No execution"}</p>
              <p>Candidate body: {execution.after?.body ?? "No execution"}</p>
              {!assertions.length && <p>No assertion changes.</p>}
              {assertions.map((assertion) => (
                <p
                  key={JSON.stringify([assertion.name, assertion.occurrence])}
                  className={
                    assertion.change === "new failure"
                      ? "text-destructive"
                      : assertion.change === "recovered"
                        ? "text-success"
                        : ""
                  }
                >
                  {assertion.name} (#{assertion.occurrence}): {assertion.before ?? "absent"} →{" "}
                  {assertion.after ?? "absent"} · {assertion.change}
                </p>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function RunComparison({
  runs,
  workspaceId,
  folderId,
}: {
  runs: RunChoice[];
  workspaceId: string;
  folderId: string;
}) {
  const [baselineId, setBaselineId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const compare = async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    setComparison(null);
    try {
      const read = async (id: string): Promise<HistoricalRun> => {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { signal: controller.signal });
        const run = await response.json();
        if (!response.ok) throw new Error(run.error ?? "Could not load saved run");
        if (run.id !== id || run.workspaceId !== workspaceId || run.folderId !== folderId)
          throw new Error("Run does not belong to this workspace and collection or folder");
        return run;
      };
      const [baseline, candidate] = await Promise.all([read(baselineId), read(candidateId)]);
      if (!controller.signal.aborted) setComparison(compareRuns(baseline, candidate));
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <details className="border-b p-3">
      <summary className="cursor-pointer font-medium">Compare saved runs</summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground">
          Compare two saved runs from this collection or folder. No requests will be sent.
        </p>
        {runs.length < 2 && <p>Save at least two runs to compare them.</p>}
        <div className="flex flex-wrap items-end gap-2">
          {(["baseline", "candidate"] as const).map((role) => (
            <label key={role} className="min-w-0 flex-1 space-y-1">
              <span className="block capitalize">{role}</span>
              <select
                aria-label={`${role} run`}
                className="h-8 w-full rounded border bg-background px-2"
                value={role === "baseline" ? baselineId : candidateId}
                disabled={loading}
                onChange={(event) => {
                  if (role === "baseline") setBaselineId(event.target.value);
                  else setCandidateId(event.target.value);
                  setComparison(null);
                  setError("");
                }}
              >
                <option value="">Select run</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {timestamp(run.startedAt)} · {run.status} · {run.id}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={
              loading ||
              !baselineId ||
              !candidateId ||
              baselineId === candidateId ||
              !runs.some((r) => r.id === baselineId) ||
              !runs.some((r) => r.id === candidateId)
            }
            onClick={() => void compare()}
          >
            {loading ? "Loading…" : "Compare"}
          </Button>
        </div>
        {baselineId && baselineId === candidateId && <p>Choose two different runs.</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {comparison && <ComparisonResults comparison={comparison} />}
      </div>
    </details>
  );
}
