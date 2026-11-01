/**
 * Usage accounting rules: metrics and their units, quota periods, and the limit arithmetic.
 * Pure (no database or framework imports) so it can be tested directly.
 */
export type UsageMetric = "requests" | "runs" | "run_ms" | "ai_tokens" | "storage_bytes";

export interface MetricInfo {
  label: string;
  unit: string;
  /** A stock (current amount kept) rather than a flow counted over a period. */
  stock?: boolean;
  description: string;
}

export const USAGE_METRICS: Record<UsageMetric, MetricInfo> = {
  requests: {
    label: "API calls",
    unit: "requests",
    description:
      "Requests sent from the app, the REST API, MCP and collection runs. A retry with the same Idempotency-Key counts once.",
  },
  runs: {
    label: "Collection runs",
    unit: "runs",
    description: "Collection runs started, including scheduled runs.",
  },
  run_ms: {
    label: "Run time",
    unit: "ms",
    description: "Wall-clock time of finished collection runs, in milliseconds.",
  },
  ai_tokens: {
    label: "AI usage",
    unit: "tokens",
    description: "Model tokens used by AI features. Recorded only when an AI feature is in use.",
  },
  storage_bytes: {
    label: "Retained storage",
    unit: "bytes",
    stock: true,
    description: "Bytes kept for history, run results and dataset versions. Measured now, not over a period.",
  },
};

export const USAGE_METRIC_KEYS = Object.keys(USAGE_METRICS) as UsageMetric[];
export const isUsageMetric = (value: unknown): value is UsageMetric =>
  typeof value === "string" && value in USAGE_METRICS;

/** Quota periods are calendar days and months in UTC. A stock metric ignores its period. */
export type LimitPeriod = "day" | "month";
export const isLimitPeriod = (value: unknown): value is LimitPeriod => value === "day" || value === "month";

export function periodStart(period: LimitPeriod, at: number): number {
  const d = new Date(at);
  return period === "day"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function periodEnd(period: LimitPeriod, at: number): number {
  const d = new Date(periodStart(period, at));
  return period === "day"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface LimitCheck {
  /** False when taking `amount` would pass the hard limit. */
  allowed: boolean;
  /** True when the amount taken would put usage past the soft limit. */
  softExceeded: boolean;
  /** Left under the hard limit after this amount, or null when there is none. */
  remaining: number | null;
}

/** Decide a reservation: hard limits block, soft limits only raise an alert. Null means no limit. */
export function checkLimit(input: {
  used: number;
  amount: number;
  soft: number | null;
  hard: number | null;
}): LimitCheck {
  const after = input.used + input.amount;
  return {
    allowed: input.hard === null || after <= input.hard,
    softExceeded: input.soft !== null && after > input.soft,
    remaining: input.hard === null ? null : Math.max(0, input.hard - after),
  };
}

export interface UsageRow {
  workspaceId: string;
  workspaceName: string;
  metric: UsageMetric;
  unit: string;
  used: number;
}

const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function usageToCsv(from: number, to: number, rows: UsageRow[]): string {
  const lines = ["from,to,workspaceId,workspace,metric,unit,used"];
  for (const r of rows)
    lines.push(
      [
        new Date(from).toISOString(),
        new Date(to).toISOString(),
        r.workspaceId,
        r.workspaceName,
        r.metric,
        r.unit,
        r.used,
      ]
        .map(cell)
        .join(","),
    );
  return `${lines.join("\r\n")}\r\n`;
}
