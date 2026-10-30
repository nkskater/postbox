import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareRunSummaries,
  describeBodyAvailability,
  type ComparableRun,
} from "@/core/runner/compare";
import type { RunResult } from "@/core/runner/runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-run-compare-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let repo: typeof import("@/server/repo");
let runs: typeof import("@/server/runs");
let db: typeof import("@/server/db");
let compareRoute: typeof import("@/app/api/runs/compare/route");

beforeAll(async () => {
  [repo, runs, db, compareRoute] = await Promise.all([
    import("@/server/repo"),
    import("@/server/runs"),
    import("@/server/db"),
    import("@/app/api/runs/compare/route"),
  ]);
}, 30_000);

afterAll(() => {
  db?.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeResult(overrides: Partial<RunResult> & Pick<RunResult, "requestId" | "name">): RunResult {
  return {
    iteration: 0,
    sequence: 0,
    path: "API",
    method: "GET",
    url: "https://api.example.com/v1/resource",
    status: 200,
    statusText: "OK",
    timeMs: 25,
    size: 12,
    tests: [],
    scriptErrors: [],
    error: null,
    passed: true,
    skipped: false,
    responseBody: '{"ok":true}',
    ...overrides,
  };
}

function makeRun(overrides: Partial<ComparableRun> & { results: RunResult[] }): ComparableRun {
  const results = overrides.results;
  const failedRequests = results.filter((r) => !r.passed && !r.skipped).length;
  const allTests = results.flatMap((r) => r.tests.filter((t) => !t.skipped));
  const passedTests = allTests.filter((t) => t.passed).length;
  const failedTests = allTests.length - passedTests;
  return {
    id: "run-default",
    name: "Sample Collection",
    status: failedRequests > 0 ? "failed" : "passed",
    iterations: 1,
    totalRequests: results.length,
    failedRequests,
    totalTests: allTests.length,
    passedTests,
    failedTests,
    durationMs: 100,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_100,
    ...overrides,
  };
}

describe("compareRunSummaries pure helper", () => {
  it("matches renamed requests by requestId and detects assertion regressions, recoveries, and removed/added requests", () => {
    const baseline = makeRun({
      id: "base-1",
      startedAt: 1_700_000_000_000,
      durationMs: 120,
      results: [
        makeResult({
          sequence: 0,
          requestId: "req-auth",
          name: "Login Legacy Name",
          status: 200,
          timeMs: 30,
          tests: [
            { name: "status is 200", passed: true },
            { name: "returns token", passed: true },
          ],
        }),
        makeResult({
          sequence: 1,
          requestId: "req-flaky",
          name: "List Orders",
          status: 500,
          passed: false,
          timeMs: 80,
          tests: [{ name: "orders array present", passed: false, error: "expected 500 to be 200" }],
        }),
        makeResult({
          sequence: 2,
          requestId: "req-removed",
          name: "Deprecated Endpoint",
          status: 200,
          timeMs: 10,
        }),
      ],
    });

    const candidate = makeRun({
      id: "cand-1",
      startedAt: 1_700_000_060_000,
      durationMs: 155,
      results: [
        makeResult({
          sequence: 0,
          requestId: "req-auth",
          name: "Login Renamed",
          status: 500,
          passed: false,
          timeMs: 75,
          tests: [
            { name: "status is 200", passed: false, error: "expected 500 to equal 200" },
            { name: "returns token", passed: true },
          ],
        }),
        makeResult({
          sequence: 1,
          requestId: "req-flaky",
          name: "List Orders",
          status: 200,
          passed: true,
          timeMs: 40,
          tests: [{ name: "orders array present", passed: true }],
        }),
        makeResult({
          sequence: 2,
          requestId: "req-added",
          name: "New Healthcheck",
          status: 204,
          timeMs: 15,
        }),
      ],
    });

    const diff = compareRunSummaries(baseline, candidate);
    expect(diff.baseline).toMatchObject({
      id: "base-1",
      startedAt: 1_700_000_000_000,
      incomplete: false,
    });
    expect(diff.candidate).toMatchObject({
      id: "cand-1",
      startedAt: 1_700_000_060_000,
      incomplete: false,
    });
    expect(diff.deltaDurationMs).toBe(35);
    expect(diff.counts).toEqual({
      totalExecutions: 4,
      regressedExecutions: 1,
      recoveredExecutions: 1,
      changedExecutions: 0,
      addedExecutions: 1,
      missingExecutions: 1,
      unchangedExecutions: 0,
      regressedAssertions: 1,
      recoveredAssertions: 1,
      statusChanges: 2,
      renamedRequests: 1,
    });

    const byReq = Object.fromEntries(diff.executions.map((e) => [e.requestId, e]));
    expect(byReq["req-auth"]).toMatchObject({
      outcome: "regressed",
      name: "Login Renamed",
      baselineName: "Login Legacy Name",
      candidateName: "Login Renamed",
      renamed: true,
      statusChanged: true,
      baselineStatus: 200,
      candidateStatus: 500,
      deltaTimeMs: 45,
    });
    expect(byReq["req-auth"].regressedAssertions).toHaveLength(1);
    expect(byReq["req-auth"].regressedAssertions[0]).toMatchObject({
      name: "status is 200",
      outcome: "regressed",
      candidateError: "expected 500 to equal 200",
    });

    expect(byReq["req-flaky"]).toMatchObject({
      outcome: "recovered",
      statusChanged: true,
      baselineStatus: 500,
      candidateStatus: 200,
      deltaTimeMs: -40,
    });
    expect(byReq["req-flaky"].recoveredAssertions).toHaveLength(1);

    expect(byReq["req-removed"]).toMatchObject({
      outcome: "missing",
      baselineName: "Deprecated Endpoint",
      candidateName: null,
    });
    expect(byReq["req-added"]).toMatchObject({
      outcome: "added",
      baselineName: null,
      candidateName: "New Healthcheck",
    });
  });

  it("matches repeated executions within an iteration and across multiple iterations by (requestId, iteration, occurrence)", () => {
    const baseline = makeRun({
      id: "base-loop",
      iterations: 2,
      results: [
        // Iteration 0: req-poll executes twice (occurrence 0 and 1)
        makeResult({ sequence: 0, iteration: 0, requestId: "req-poll", name: "Poll Job", status: 202, timeMs: 10 }),
        makeResult({ sequence: 1, iteration: 0, requestId: "req-poll", name: "Poll Job", status: 200, timeMs: 12 }),
        // Iteration 1: req-poll executes once
        makeResult({ sequence: 2, iteration: 1, requestId: "req-poll", name: "Poll Job", status: 200, timeMs: 15 }),
      ],
    });

    const candidate = makeRun({
      id: "cand-loop",
      iterations: 2,
      results: [
        // Iteration 0: first occurrence still 202, second occurrence regresses to 503, third occurrence added
        makeResult({ sequence: 0, iteration: 0, requestId: "req-poll", name: "Poll Job", status: 202, timeMs: 11 }),
        makeResult({
          sequence: 1,
          iteration: 0,
          requestId: "req-poll",
          name: "Poll Job",
          status: 503,
          passed: false,
          timeMs: 50,
        }),
        makeResult({ sequence: 2, iteration: 0, requestId: "req-poll", name: "Poll Job", status: 200, timeMs: 14 }),
        // Iteration 1: req-poll passes
        makeResult({ sequence: 3, iteration: 1, requestId: "req-poll", name: "Poll Job", status: 200, timeMs: 15 }),
      ],
    });

    const diff = compareRunSummaries(baseline, candidate);
    expect(diff.executions.map((e) => [e.iteration, e.occurrence, e.outcome, e.baselineStatus, e.candidateStatus])).toEqual([
      [0, 0, "unchanged", 202, 202],
      [0, 1, "regressed", 200, 503],
      [0, 2, "added", null, 200],
      [1, 0, "unchanged", 200, 200],
    ]);
  });

  it("handles skipped requests, transport/script errors, incomplete runs, and body availability states", () => {
    const baseline = makeRun({
      id: "base-inc",
      status: "passed",
      totalRequests: 3,
      results: [
        makeResult({
          sequence: 0,
          requestId: "req-1",
          name: "Step 1",
          skipped: true,
          status: null,
          responseBody: undefined,
        }),
        makeResult({
          sequence: 1,
          requestId: "req-2",
          name: "Step 2",
          status: 200,
          size: 50_000,
          responseBody: "x".repeat(16 * 1024),
        }),
        makeResult({
          sequence: 2,
          requestId: "req-3",
          name: "Step 3",
          status: 200,
          responseBody: '{"token":"********"}',
        }),
      ],
    });

    // Candidate was cancelled midway after req-2 failed with a network error.
    const candidate = makeRun({
      id: "cand-inc",
      status: "cancelled",
      totalRequests: 3,
      results: [
        makeResult({
          sequence: 0,
          requestId: "req-1",
          name: "Step 1",
          skipped: false,
          status: 200,
          responseBody: '{"hello":"world"}',
        }),
        makeResult({
          sequence: 1,
          requestId: "req-2",
          name: "Step 2",
          status: null,
          passed: false,
          error: "connect ECONNREFUSED 127.0.0.1:9999",
          responseBody: undefined,
        }),
      ],
    });

    const diff = compareRunSummaries(baseline, candidate);
    expect(diff.baseline.incomplete).toBe(false);
    expect(diff.candidate.incomplete).toBe(true);

    const [e1, e2, e3] = diff.executions;
    expect(e1).toMatchObject({
      requestId: "req-1",
      outcome: "changed",
      skippedChanged: true,
      baselineBodyState: "unavailable",
      candidateBodyState: "available",
    });
    expect(e2).toMatchObject({
      requestId: "req-2",
      outcome: "regressed",
      baselineStatus: 200,
      candidateStatus: null,
      baselineBodyState: "truncated",
      candidateBodyState: "unavailable",
    });
    expect(e3).toMatchObject({
      requestId: "req-3",
      outcome: "missing",
      baselineBodyState: "redacted",
      candidateBodyState: "unavailable",
    });

    expect(describeBodyAvailability(null)).toBe("unavailable");
  });
});

describe("persisted run comparison and workspace authorization", () => {
  function insertPersistedRun(input: {
    workspaceId: string;
    folderId: string;
    name: string;
    status: "passed" | "failed" | "cancelled" | "error";
    startedAt: number;
    durationMs: number;
    results: Array<Partial<RunResult> & { requestId: string; name: string; sequence: number }>;
  }) {
    const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
    const sqliteDb = db.getDb();
    sqliteDb
      .insert(db.schema.runs)
      .values({
        id: runId,
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        name: input.name,
        status: input.status,
        options: { iterations: 1, delayMs: 0, stopOnFailure: false, timeoutMs: 5000, verifySsl: true },
        environmentId: null,
        iterations: 1,
        totalRequests: input.results.length,
        failedRequests: input.results.filter((r) => r.passed === false).length,
        totalTests: 1,
        passedTests: input.results.filter((r) => r.passed !== false).length,
        failedTests: input.results.filter((r) => r.passed === false).length,
        durationMs: input.durationMs,
        source: "manual",
        startedAt: input.startedAt,
        finishedAt: input.startedAt + input.durationMs,
      })
      .run();

    for (const r of input.results) {
      sqliteDb
        .insert(db.schema.runResults)
        .values({
          id: `res_${Math.random().toString(36).slice(2, 10)}`,
          runId,
          iteration: r.iteration ?? 0,
          sequence: r.sequence,
          requestId: r.requestId,
          name: r.name,
          method: r.method ?? "GET",
          url: r.url ?? "https://api.example.com/items",
          status: r.status !== undefined ? r.status : 200,
          statusText: r.statusText ?? "OK",
          timeMs: r.timeMs ?? 20,
          size: r.size ?? 32,
          tests: r.tests ?? [{ name: "status 200", passed: r.passed ?? true }],
          error: r.error ?? null,
          passed: r.passed ?? true,
          path: r.path ?? input.name,
          skipped: r.skipped ?? false,
          scriptErrors: r.scriptErrors ?? [],
          responseBody: r.responseBody ?? null,
          responseHeaders: null,
          createdAt: input.startedAt,
        })
        .run();
    }
    return runId;
  }

  it("compares two persisted runs via GET /api/runs/compare without re-running requests and preserves secret redaction", async () => {
    const ws = repo.createWorkspace("Compare Workspace");
    const folder = repo.createFolder(ws.id, null, { name: "Checkout Suite" });

    const baseId = insertPersistedRun({
      workspaceId: ws.id,
      folderId: folder.id,
      name: "Checkout Suite",
      status: "passed",
      startedAt: 1_700_000_000_000,
      durationMs: 90,
      results: [
        {
          sequence: 0,
          requestId: "req-charge",
          name: "Create Charge",
          status: 200,
          passed: true,
          responseBody: '{"apiKey":"********","ok":true}',
          tests: [{ name: "charge succeeds", passed: true }],
        },
      ],
    });

    const candId = insertPersistedRun({
      workspaceId: ws.id,
      folderId: folder.id,
      name: "Checkout Suite",
      status: "failed",
      startedAt: 1_700_000_100_000,
      durationMs: 140,
      results: [
        {
          sequence: 0,
          requestId: "req-charge",
          name: "Create Charge (v2)",
          status: 502,
          passed: false,
          responseBody: undefined,
          tests: [{ name: "charge succeeds", passed: false, error: "502 Bad Gateway" }],
        },
      ],
    });

    const direct = runs.compareRuns({
      workspaceId: ws.id,
      folderId: folder.id,
      baselineId: baseId,
      candidateId: candId,
    });
    expect(direct.counts.regressedExecutions).toBe(1);

    const req = new Request(
      `http://localhost/api/runs/compare?workspaceId=${ws.id}&folderId=${folder.id}&baselineId=${baseId}&candidateId=${candId}`,
    );
    const res = await compareRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseline.id).toBe(baseId);
    expect(body.candidate.id).toBe(candId);
    expect(body.counts.regressedExecutions).toBe(1);
    expect(body.executions[0]).toMatchObject({
      requestId: "req-charge",
      renamed: true,
      baselineName: "Create Charge",
      candidateName: "Create Charge (v2)",
      baselineBodyState: "redacted",
      candidateBodyState: "unavailable",
    });
    expect(body.executions[0].baseline.responseBody).toBe('{"apiKey":"********","ok":true}');
  });

  it("enforces workspace and collection ownership on run comparison reads", async () => {
    const wsA = repo.createWorkspace("Workspace A");
    const folderA1 = repo.createFolder(wsA.id, null, { name: "Collection A1" });
    const folderA2 = repo.createFolder(wsA.id, null, { name: "Collection A2" });
    const wsB = repo.createWorkspace("Workspace B");
    const folderB = repo.createFolder(wsB.id, null, { name: "Collection B" });

    const runA1a = insertPersistedRun({
      workspaceId: wsA.id,
      folderId: folderA1.id,
      name: "Collection A1",
      status: "passed",
      startedAt: 1000,
      durationMs: 10,
      results: [{ sequence: 0, requestId: "r1", name: "R1" }],
    });
    const runA1b = insertPersistedRun({
      workspaceId: wsA.id,
      folderId: folderA1.id,
      name: "Collection A1",
      status: "passed",
      startedAt: 2000,
      durationMs: 12,
      results: [{ sequence: 0, requestId: "r1", name: "R1" }],
    });
    const runA2 = insertPersistedRun({
      workspaceId: wsA.id,
      folderId: folderA2.id,
      name: "Collection A2",
      status: "passed",
      startedAt: 3000,
      durationMs: 15,
      results: [{ sequence: 0, requestId: "r2", name: "R2" }],
    });
    const runB = insertPersistedRun({
      workspaceId: wsB.id,
      folderId: folderB.id,
      name: "Collection B",
      status: "passed",
      startedAt: 4000,
      durationMs: 20,
      results: [{ sequence: 0, requestId: "r3", name: "R3" }],
    });

    // Cross-workspace run comparison returns 404.
    const crossWsRes = await compareRoute.GET(
      new Request(
        `http://localhost/api/runs/compare?workspaceId=${wsA.id}&baselineId=${runA1a}&candidateId=${runB}`,
      ),
    );
    expect(crossWsRes.status).toBe(404);

    // Querying with another workspace's ID returns 404.
    const wrongWsRes = await compareRoute.GET(
      new Request(
        `http://localhost/api/runs/compare?workspaceId=${wsB.id}&baselineId=${runA1a}&candidateId=${runA1b}`,
      ),
    );
    expect(wrongWsRes.status).toBe(404);

    // Comparing runs from different collections in the same workspace returns 400.
    const crossFolderRes = await compareRoute.GET(
      new Request(
        `http://localhost/api/runs/compare?workspaceId=${wsA.id}&baselineId=${runA1a}&candidateId=${runA2}`,
      ),
    );
    expect(crossFolderRes.status).toBe(400);

    // Comparing a run against itself returns 400.
    const sameRunRes = await compareRoute.GET(
      new Request(
        `http://localhost/api/runs/compare?workspaceId=${wsA.id}&baselineId=${runA1a}&candidateId=${runA1a}`,
      ),
    );
    expect(sameRunRes.status).toBe(400);
  });
});
