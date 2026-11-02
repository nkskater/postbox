/** Pass/fail thresholds over a load-test snapshot, e.g. `p95<500`, `errorRate<0.01`, `rps>=20@Create order`. */
import { z } from "zod";
import type { LoadSnapshot } from "./metrics";

export const THRESHOLD_METRICS = [
  "min",
  "avg",
  "p50",
  "p90",
  "p95",
  "p99",
  "max",
  "errorRate",
  "checkFailRate",
  "rps",
  "requests",
] as const;
export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];
const OPS = ["<", "<=", ">", ">="] as const;

export const thresholdSchema = z.object({
  metric: z.enum(THRESHOLD_METRICS),
  op: z.enum(OPS),
  value: z.number().finite().min(0),
  /** Limit to one request by name; omit for the whole test. */
  request: z.string().min(1).max(200).optional(),
});
export type Threshold = z.infer<typeof thresholdSchema>;
export const thresholdsSchema = z.array(thresholdSchema).max(30);

export interface ThresholdResult extends Threshold {
  label: string;
  actual: number | null;
  passed: boolean;
}

const UNIT: Partial<Record<ThresholdMetric, string>> = {
  min: " ms",
  avg: " ms",
  p50: " ms",
  p90: " ms",
  p95: " ms",
  p99: " ms",
  max: " ms",
  rps: " req/s",
};

export const describeThreshold = (t: Threshold) =>
  `${t.metric}${t.op}${t.value}${t.request ? ` @ ${t.request}` : ""}`;

/** Parse `p95<500`, `errorRate<=0.01` or `p99<800@Get user`. */
export function parseThreshold(text: string): Threshold {
  const at = text.indexOf("@");
  const expression = (at >= 0 ? text.slice(0, at) : text).trim();
  const request = at >= 0 ? text.slice(at + 1).trim() : undefined;
  const m = /^([A-Za-z0-9]+)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/.exec(expression);
  if (!m)
    throw new Error(`Invalid threshold "${text}": use metric<value, for example p95<500 or errorRate<0.01`);
  return thresholdSchema.parse({
    metric: m[1],
    op: m[2],
    value: Number(m[3]),
    ...(request ? { request } : {}),
  });
}

function actualOf(snapshot: LoadSnapshot, t: Threshold): number | null {
  const scope = t.request ? snapshot.byRequest.find((r) => r.name === t.request) : null;
  if (t.request && !scope) return null;
  const requests = scope ? scope.requests : snapshot.requests;
  if (requests === 0 && t.metric !== "requests") return null;
  switch (t.metric) {
    case "errorRate":
      return scope ? scope.errorRate : snapshot.errorRate;
    case "checkFailRate":
      return t.request ? null : snapshot.checkFailRate;
    case "rps":
      return scope ? scope.requests / Math.max(snapshot.elapsedSec, 0.001) : snapshot.rps;
    case "requests":
      return requests;
    default:
      return (scope ? scope.latency : snapshot.latency)[t.metric];
  }
}

/** A threshold with no data to measure (unknown request, no requests) fails, so a typo cannot pass silently. */
export function evaluateThresholds(
  snapshot: LoadSnapshot,
  thresholds: readonly Threshold[],
): ThresholdResult[] {
  return thresholds.map((t) => {
    const actual = actualOf(snapshot, t);
    const passed =
      actual !== null &&
      (t.op === "<"
        ? actual < t.value
        : t.op === "<="
          ? actual <= t.value
          : t.op === ">"
            ? actual > t.value
            : actual >= t.value);
    const unit = UNIT[t.metric] ?? "";
    return {
      ...t,
      actual: actual === null ? null : Math.round(actual * 10000) / 10000,
      passed,
      label: `${describeThreshold(t)}${unit ? ` (${unit.trim()})` : ""}`,
    };
  });
}
