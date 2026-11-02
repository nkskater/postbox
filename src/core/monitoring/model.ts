import { z } from "zod";
export const monitorRulesSchema = z.object({
  maxLatencyMs: z.number().positive().max(300000).nullable().default(null),
  minAvailability: z.number().min(0).max(100).default(100),
  minAssertions: z.number().min(0).max(100).nullable().default(null),
  failAfter: z.number().int().min(1).max(100).default(1),
  recoverAfter: z.number().int().min(1).max(100).default(1),
  maxDurationMs: z.number().int().min(1000).max(300000).default(60000),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
});
export type MonitorRules = z.infer<typeof monitorRulesSchema>;
export interface MonitorMetrics {
  requests: number;
  available: number;
  tests: number;
  passedTests: number;
  p95Ms: number | null;
  availability: number;
  assertions: number | null;
  scriptErrors: number;
}
export interface ObservedRequest {
  status: number | null;
  timeMs: number | null;
  skipped: boolean;
  tests: { passed: boolean; skipped?: boolean }[];
  scriptErrors?: readonly unknown[];
}
export function monitorMetrics(results: ObservedRequest[]): MonitorMetrics {
  const observed = results.filter((r) => !r.skipped),
    latencies = observed
      .flatMap((r) => (r.timeMs === null ? [] : [Math.max(0, r.timeMs)]))
      .sort((a, b) => a - b),
    tests = observed.flatMap((r) => r.tests).filter((t) => !t.skipped),
    available = observed.filter((r) => r.status !== null && r.status >= 200 && r.status < 400).length,
    passedTests = tests.filter((t) => t.passed).length;
  return {
    scriptErrors: observed.reduce((n, r) => n + (r.scriptErrors?.length ?? 0), 0),
    requests: observed.length,
    available,
    tests: tests.length,
    passedTests,
    p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    availability: observed.length ? (100 * available) / observed.length : 0,
    assertions: tests.length ? (100 * passedTests) / tests.length : null,
  };
}
export function checkMonitor(
  rules: MonitorRules,
  metrics: MonitorMetrics,
  runStatus: string,
  timedOut = false,
) {
  const reasons: string[] = [];
  if (timedOut) reasons.push("Monitor run timed out");
  else if (runStatus === "cancelled") return { outcome: "skipped" as const, reasons: ["Run cancelled"] };
  if (runStatus === "error") reasons.push("Run could not complete");
  if (!metrics.requests) reasons.push("No requests were observed");
  if (metrics.availability < rules.minAvailability)
    reasons.push(`Availability ${metrics.availability.toFixed(2)}% is below ${rules.minAvailability}%`);
  if (rules.maxLatencyMs !== null && (metrics.p95Ms === null || metrics.p95Ms > rules.maxLatencyMs))
    reasons.push(
      metrics.p95Ms === null
        ? "Latency unavailable"
        : `p95 latency ${metrics.p95Ms.toFixed(2)} ms exceeds ${rules.maxLatencyMs} ms`,
    );
  if (
    rules.minAssertions !== null &&
    (metrics.assertions === null || metrics.assertions < rules.minAssertions)
  )
    reasons.push(
      metrics.assertions === null
        ? "No assertions were executed"
        : `Assertions ${metrics.assertions.toFixed(2)}% is below ${rules.minAssertions}%`,
    );
  if (rules.minAssertions !== null && metrics.scriptErrors)
    reasons.push(`${metrics.scriptErrors} assertion script errors`);
  return { outcome: reasons.length ? ("failed" as const) : ("passed" as const), reasons };
}
export function monitorTransition(
  current: { state: string; failures: number; successes: number },
  outcome: "passed" | "failed" | "skipped",
  rules: MonitorRules,
) {
  if (outcome === "skipped") return { ...current, event: null };
  const failures = outcome === "failed" ? current.failures + 1 : 0,
    successes = outcome === "passed" ? current.successes + 1 : 0;
  const incident = current.state !== "incident" && failures >= rules.failAfter,
    recovery = current.state === "incident" && successes >= rules.recoverAfter;
  return {
    state: incident
      ? "incident"
      : recovery
        ? "healthy"
        : current.state === "unknown" && outcome === "passed"
          ? "healthy"
          : current.state,
    failures,
    successes,
    event: incident ? ("monitor.incident" as const) : recovery ? ("monitor.recovered" as const) : null,
  };
}
