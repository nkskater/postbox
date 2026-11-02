/** Load-test reports: JSON (everything), CSV (summary, per request, time series) and JUnit (one case per threshold). */
import type { LoadSnapshot } from "./metrics";
import { describeProfile, type LoadProfile } from "./profile";
import type { ThresholdResult } from "./thresholds";

export type LoadReportFormat = "json" | "csv" | "junit";

export interface LoadReportInput {
  id?: string;
  name: string;
  status: string;
  profile: LoadProfile;
  startedAt: number;
  finishedAt: number;
  stoppedBy: string | null;
  snapshot: LoadSnapshot;
  thresholds: ThresholdResult[];
  warnings: string[];
}

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // spreadsheet formula injection
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const row = (cells: unknown[]) => cells.map(csvCell).join(",");
const xml = (s: unknown) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

export function renderLoadReport(
  run: LoadReportInput,
  format: LoadReportFormat,
): { body: string; contentType: string; ext: string } {
  const s = run.snapshot;
  if (format === "csv") {
    const lines = [
      row(["section", "name", "value"]),
      row(["summary", "name", run.name]),
      row(["summary", "status", run.status]),
      row(["summary", "profile", describeProfile(run.profile)]),
      row(["summary", "started", new Date(run.startedAt).toISOString()]),
      row(["summary", "elapsed_seconds", s.elapsedSec]),
      row(["summary", "requests", s.requests]),
      row(["summary", "errors", s.errors]),
      row(["summary", "error_rate", s.errorRate]),
      row(["summary", "requests_per_second", s.rps]),
      row(["summary", "peak_vus", s.peakVus]),
      row(["summary", "bytes", s.bytes]),
      row(["summary", "checks_failed", s.checksFailed]),
      ...Object.entries(s.latency).map(([k, v]) => row(["latency_ms", k, v])),
      ...Object.entries(s.statuses).map(([k, v]) => row(["status", k, v])),
      ...run.thresholds.map((t) =>
        row(["threshold", t.label, `${t.passed ? "pass" : "fail"} (actual ${t.actual ?? "n/a"})`]),
      ),
      "",
      row([
        "request",
        "requests",
        "errors",
        "error_rate",
        "min_ms",
        "avg_ms",
        "p50_ms",
        "p90_ms",
        "p95_ms",
        "p99_ms",
        "max_ms",
      ]),
      ...s.byRequest.map((r) =>
        row([
          r.name,
          r.requests,
          r.errors,
          r.errorRate,
          r.latency.min,
          r.latency.avg,
          r.latency.p50,
          r.latency.p90,
          r.latency.p95,
          r.latency.p99,
          r.latency.max,
        ]),
      ),
      "",
      row(["t_seconds", "requests", "errors", "rps", "p50_ms", "p95_ms", "vus"]),
      ...s.series.map((p) => row([p.t, p.requests, p.errors, p.rps, p.p50, p.p95, p.vus])),
    ];
    return { body: lines.join("\n") + "\n", contentType: "text/csv", ext: "csv" };
  }
  if (format === "junit") {
    const failed = run.thresholds.filter((t) => !t.passed).length;
    const cases = run.thresholds.map((t) =>
      t.passed
        ? `    <testcase classname="${xml(run.name)}" name="${xml(t.label)}"/>`
        : `    <testcase classname="${xml(run.name)}" name="${xml(t.label)}"><failure message="${xml(
            t.actual === null ? "no data to measure" : `actual ${t.actual}`,
          )}"/></testcase>`,
    );
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${xml(run.name)} (${xml(describeProfile(run.profile))})" tests="${run.thresholds.length}" failures="${failed}" time="${s.elapsedSec}">
${cases.join("\n")}
  </testsuite>
</testsuites>
`;
    return { body, contentType: "application/xml", ext: "xml" };
  }
  return { body: JSON.stringify(run, null, 2), contentType: "application/json", ext: "json" };
}
