import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bodyAvailability, compareRuns, type HistoricalRun } from "@/core/runner/compare";
import type { RunResult } from "@/core/runner/runner";
import { ComparisonResults } from "@/components/runner/RunComparison";

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    requestId: "request-1",
    name: "Original",
    method: "GET",
    url: "https://example.test",
    path: "Collection",
    iteration: 0,
    sequence: 0,
    status: 200,
    statusText: "OK",
    timeMs: 100,
    size: 0,
    tests: [],
    scriptErrors: [],
    error: null,
    passed: true,
    skipped: false,
    ...patch,
  };
}
function run(id: string, results: RunResult[], patch: Partial<HistoricalRun> = {}): HistoricalRun {
  return {
    id,
    workspaceId: "workspace",
    folderId: "collection",
    name: "Run",
    status: "passed",
    iterations: 1,
    totalRequests: results.length,
    failedRequests: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    durationMs: 200,
    startedAt: 1700000000000,
    finishedAt: 1700000000200,
    results,
    ...patch,
  };
}

describe("historical run comparison", () => {
  it("matches stable IDs, iteration and occurrence even when names or sequence numbers change", () => {
    const before = run("before", [
      result({ sequence: 0, name: "Before rename" }),
      result({ sequence: 1, timeMs: 50, status: 201 }),
      result({ sequence: 2, iteration: 1, status: 202 }),
      result({ sequence: 3, requestId: "removed", name: "Same name" }),
    ]);
    const after = run("after", [
      result({ sequence: 10, name: "Renamed", timeMs: 130, status: 500, passed: false }),
      result({ sequence: 20, timeMs: 25, status: 201 }),
      result({ sequence: 30, iteration: 1, status: 202 }),
      result({ sequence: 40, requestId: "new", name: "Same name" }),
    ]);
    const comparison = compareRuns(before, after);
    expect(comparison.executions.map((e) => [e.requestId, e.iteration, e.occurrence, e.presence])).toEqual([
      ["request-1", 0, 1, "matched"],
      ["request-1", 0, 2, "matched"],
      ["request-1", 1, 1, "matched"],
      ["removed", 0, 1, "missing"],
      ["new", 0, 1, "added"],
    ]);
    expect(comparison.executions[0]).toMatchObject({
      statusChanged: true,
      outcomeChanged: true,
      timeDeltaMs: 30,
      timeDeltaPercent: 30,
    });
    expect(comparison.executions[1]).toMatchObject({
      statusChanged: false,
      timeDeltaMs: -25,
      timeDeltaPercent: -50,
    });
    expect(comparison.counts).toMatchObject({ added: 1, missing: 1, statusChanges: 1, outcomeChanges: 1 });
    expect(before.results[0].name).toBe("Before rename");
  });

  it("pairs duplicate assertion names by occurrence and distinguishes skipped/removed tests from recoveries", () => {
    const before = result({
      tests: [
        { name: "duplicate", passed: true },
        { name: "duplicate", passed: false },
        { name: "removed failure", passed: false },
        { name: "skipped now", passed: false },
        { name: "assertion <script>", passed: true },
      ],
    });
    const after = result({
      tests: [
        { name: "duplicate", passed: false },
        { name: "duplicate", passed: true },
        { name: "skipped now", passed: true, skipped: true },
        { name: "new failure", passed: false },
        { name: "assertion <script>", passed: true },
      ],
    });
    const comparison = compareRuns(run("before", [before]), run("after", [after]));
    expect(comparison.counts).toMatchObject({ newFailures: 2, recovered: 1 });
    expect(comparison.executions[0].assertions.map((a) => [a.name, a.occurrence, a.change])).toEqual([
      ["duplicate", 1, "new failure"],
      ["duplicate", 2, "recovered"],
      ["removed failure", 1, "removed"],
      ["skipped now", 1, "changed"],
      ["assertion <script>", 1, "unchanged"],
      ["new failure", 1, "new failure"],
    ]);
  });

  it("shows execution errors/skips and unavailable/zero-baseline timing honestly", () => {
    const comparison = compareRuns(
      run("before", [result({ timeMs: 0 }), result({ requestId: "skip", sequence: 1 })]),
      run("after", [
        result({ timeMs: 10, error: "network failure", status: null, passed: false }),
        result({ requestId: "skip", sequence: 1, skipped: true, timeMs: null }),
        result({
          requestId: "script",
          sequence: 2,
          scriptErrors: [{ phase: "test", source: "test", message: "error" }],
        }),
      ]),
    );
    expect(comparison.executions[0]).toMatchObject({
      after: { outcome: "error" },
      timeDeltaMs: 10,
      timeDeltaPercent: null,
    });
    expect(comparison.executions[1]).toMatchObject({
      after: { outcome: "skipped" },
      timeDeltaMs: null,
      timeDeltaPercent: null,
    });
    expect(comparison.executions[2].after?.outcome).toBe("error");
  });

  it.each(["running", "cancelled", "error"] as const)(
    "warns about %s runs and missing retained results",
    (status) => {
      const comparison = compareRuns(
        run("before", [result()]),
        run("after", [], { status, totalRequests: 5 }),
      );
      expect(comparison.warnings.join(" ")).toContain(`Candidate is ${status}`);
      expect(comparison.warnings.join(" ")).toContain("0 retained executions out of 5");
      expect(comparison.counts.missing).toBe(1);
      expect(comparison.counts.recovered).toBe(0);
    },
  );

  it("does not match unidentified deleted requests by name or empty ID", () => {
    const comparison = compareRuns(
      run("before", [result({ requestId: "" })]),
      run("after", [result({ requestId: "" })]),
    );
    expect(comparison.counts).toMatchObject({ added: 1, missing: 1 });
    expect(comparison.warnings).toHaveLength(2);
  });

  it("rejects same-run, cross-workspace, cross-folder and deleted-folder pairs", () => {
    const before = run("before", []);
    expect(() => compareRuns(before, before)).toThrow(/different runs/);
    for (const patch of [{ workspaceId: "other" }, { folderId: "other" }, { folderId: null }])
      expect(() => compareRuns(before, run("after", [], patch))).toThrow(/same workspace/);
  });

  it("handles empty runs and different result ordering without mutating saved data", () => {
    expect(compareRuns(run("before", []), run("after", [])).executions).toEqual([]);
    const before = run("before", [
      result({ sequence: 10, name: "second" }),
      result({ sequence: 0, name: "first" }),
    ]);
    const original = structuredClone(before);
    const comparison = compareRuns(before, run("after", [result({ sequence: 0 }), result({ sequence: 10 })]));
    expect(comparison.executions[0].before?.name).toBe("first");
    expect(before).toEqual(original);
  });

  it("labels unavailable, truncated, redacted and multibyte previews without returning stored bodies", () => {
    expect(bodyAvailability(result())).toMatch(/Unavailable/);
    expect(bodyAvailability(result({ responseBody: "short", size: 100 }))).toBe("Truncated preview");
    expect(bodyAvailability(result({ responseBody: "********", size: 1 }))).toMatch(/Redaction marker/);
    expect(bodyAvailability(result({ responseBody: "é", size: 2 }))).toMatch(/metadata unavailable/);
    const comparison = compareRuns(
      run("before", [result({ responseBody: "safe-********", size: 100 })]),
      run("after", [result({ responseBody: "safe-********", size: 100 })]),
    );
    expect(JSON.stringify(comparison)).not.toContain("safe-");
    const markup = renderToStaticMarkup(createElement(ComparisonResults, { comparison }));
    expect(markup).toContain("Redaction marker");
    expect(markup).toContain("Bodies are not compared");
    expect(markup).toContain("before");
    expect(markup).toContain("after");
  });

  it("renders names as text and makes renamed requests, missing bodies and regressions visible", () => {
    const comparison = compareRuns(
      run("baseline-id", [
        result({ name: "Old name", tests: [{ name: "<img src=x onerror=alert(1)>", passed: true }] }),
      ]),
      run("candidate-id", [
        result({
          name: "New <script>name</script>",
          status: 500,
          tests: [{ name: "<img src=x onerror=alert(1)>", passed: false }],
        }),
      ]),
    );
    const markup = renderToStaticMarkup(createElement(ComparisonResults, { comparison }));
    expect(markup).toContain("New assertion failures: 1");
    expect(markup).toContain("Renamed:");
    expect(markup).toContain("Unavailable (not retained or binary)");
    expect(markup).toContain("baseline-id");
    expect(markup).toContain("candidate-id");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
  });
});
