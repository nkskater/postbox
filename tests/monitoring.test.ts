import { describe, expect, it } from "vitest";
import { monitorRulesSchema, monitorMetrics, checkMonitor, monitorTransition } from "@/core/monitoring/model";
const rules = monitorRulesSchema.parse({
  maxLatencyMs: 100,
  minAvailability: 100,
  minAssertions: 100,
  failAfter: 2,
  recoverAfter: 2,
});
describe("monitor thresholds and incident transitions", () => {
  it("computes p95 and percentages while excluding skipped requests and assertions", () => {
    expect(
      monitorMetrics([
        {
          status: 200,
          timeMs: 10,
          skipped: false,
          tests: [{ passed: true }, { passed: false, skipped: true }],
        },
        { status: null, timeMs: 200, skipped: false, tests: [{ passed: false }] },
        { status: 500, timeMs: 900, skipped: true, tests: [] },
      ]),
    ).toEqual({
      scriptErrors: 0,
      requests: 2,
      available: 1,
      tests: 2,
      passedTests: 1,
      p95Ms: 200,
      availability: 50,
      assertions: 50,
    });
  });
  it("evaluates latency, assertion and availability boundaries and missing assertions honestly", () => {
    const metrics = monitorMetrics([{ status: 200, timeMs: 100, skipped: false, tests: [{ passed: true }] }]);
    expect(checkMonitor(rules, metrics, "passed").outcome).toBe("passed");
    expect(checkMonitor(rules, { ...metrics, p95Ms: 101 }, "passed").reasons[0]).toContain("latency");
    expect(checkMonitor(rules, { ...metrics, tests: 0, assertions: null }, "passed").reasons).toContain(
      "No assertions were executed",
    );
    expect(checkMonitor(rules, { ...metrics, availability: 0 }, "failed").outcome).toBe("failed");
    expect(checkMonitor(rules, { ...metrics, scriptErrors: 1 }, "failed").outcome).toBe("failed");
  });
  it("deduplicates repeated failures/recovery and only emits at configured streaks", () => {
    let state = { state: "unknown", failures: 0, successes: 0 };
    let next = monitorTransition(state, "failed", rules);
    expect(next.event).toBeNull();
    next = monitorTransition(next, "failed", rules);
    expect(next.event).toBe("monitor.incident");
    next = monitorTransition(next, "failed", rules);
    expect(next.event).toBeNull();
    next = monitorTransition(next, "passed", rules);
    expect(next.state).toBe("incident");
    expect(next.event).toBeNull();
    next = monitorTransition(next, "passed", rules);
    expect(next.event).toBe("monitor.recovered");
    expect(monitorTransition(next, "passed", rules).event).toBeNull();
    state = { state: "incident", failures: 2, successes: 0 };
    expect(monitorTransition(state, "skipped", rules)).toEqual({ ...state, event: null });
  });
  it("counts transport timeouts as unavailable, total deadline as failure, and manual cancellation as a gap", () => {
    const unavailable = monitorMetrics([{ status: null, timeMs: 50, skipped: false, tests: [] }]);
    expect(checkMonitor(rules, unavailable, "failed").outcome).toBe("failed");
    expect(checkMonitor(rules, unavailable, "cancelled").outcome).toBe("skipped");
    expect(checkMonitor(rules, unavailable, "cancelled", true).reasons).toContain("Monitor run timed out");
  });
  it("rejects invalid policies", () => {
    for (const policy of [
      { minAvailability: 101 },
      { minAssertions: -1 },
      { failAfter: 0 },
      { recoverAfter: 101 },
      { maxLatencyMs: 0 },
      { maxDurationMs: 999 },
      { timeoutMs: 0 },
    ])
      expect(monitorRulesSchema.safeParse(policy).success).toBe(false);
  });
});
