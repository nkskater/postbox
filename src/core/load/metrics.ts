/**
 * Streaming load-test metrics with bounded memory: log-bucket latency histograms (about 1% accuracy), per-bucket
 * time series, per-request breakdowns, status and error counts. Pure; the caller supplies timestamps.
 */
export interface Sample {
  /** Milliseconds since the test started. */
  at: number;
  name: string;
  latencyMs: number;
  /** HTTP status, or null for a transport error. */
  status: number | null;
  error: string | null;
  bytes: number;
  checksPassed: number;
  checksFailed: number;
}

const GROWTH = 1.01;
const LOG_GROWTH = Math.log(GROWTH);
const FLOOR_MS = 0.01;

class Histogram {
  private buckets = new Map<number, number>();
  count = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  add(ms: number) {
    const v = Math.max(FLOOR_MS, ms);
    const index = Math.floor(Math.log(v / FLOOR_MS) / LOG_GROWTH);
    this.buckets.set(index, (this.buckets.get(index) ?? 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  /** The value below which `p` percent (0-100) of samples fall, within one bucket width. */
  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (const index of [...this.buckets.keys()].sort((a, b) => a - b)) {
      seen += this.buckets.get(index)!;
      if (seen >= rank) {
        // The bucket's geometric middle, clamped to what was actually observed.
        const mid = FLOOR_MS * Math.pow(GROWTH, index + 0.5);
        return Math.min(this.max, Math.max(this.min, mid));
      }
    }
    return this.max;
  }
}

export interface LatencyStats {
  min: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function stats(h: Histogram): LatencyStats {
  if (!h.count) return { min: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  return {
    min: round(h.min),
    avg: round(h.sum / h.count),
    p50: round(h.percentile(50)),
    p90: round(h.percentile(90)),
    p95: round(h.percentile(95)),
    p99: round(h.percentile(99)),
    max: round(h.max),
  };
}

export interface SeriesPoint {
  /** Start of the bucket, seconds since the test began. */
  t: number;
  requests: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  vus: number;
}

export interface RequestStats {
  name: string;
  requests: number;
  errors: number;
  errorRate: number;
  latency: LatencyStats;
}

export interface LoadSnapshot {
  elapsedSec: number;
  requests: number;
  errors: number;
  errorRate: number;
  /** Requests per second over the elapsed time. */
  rps: number;
  bytes: number;
  checksPassed: number;
  checksFailed: number;
  checkFailRate: number;
  latency: LatencyStats;
  peakVus: number;
  byRequest: RequestStats[];
  statuses: Record<string, number>;
  errorKinds: { message: string; count: number }[];
  series: SeriesPoint[];
}

export const MAX_REQUEST_NAMES = 100;
const MAX_ERROR_KINDS = 20;
const OTHER = "(other requests)";

/** An error means no response, or an HTTP status of 400 or more. */
export const isError = (s: Pick<Sample, "status" | "error">) =>
  s.error !== null || s.status === null || s.status >= 400;

interface Bucket {
  hist: Histogram;
  errors: number;
  vus: number;
}

export class LoadMetrics {
  private all = new Histogram();
  private names = new Map<string, { hist: Histogram; errors: number }>();
  private statuses = new Map<string, number>();
  private errorKinds = new Map<string, number>();
  private buckets = new Map<number, Bucket>();
  private requests = 0;
  private errors = 0;
  private bytes = 0;
  private checksPassed = 0;
  private checksFailed = 0;
  private peakVus = 0;
  private currentVus = 0;

  /** `bucketSec` is the time-series resolution; pick it from the test length to keep the series short. */
  constructor(private bucketSec = 1) {}

  setVus(vus: number) {
    this.currentVus = vus;
    if (vus > this.peakVus) this.peakVus = vus;
  }

  get total() {
    return this.requests;
  }

  record(s: Sample) {
    this.requests++;
    const failed = isError(s);
    if (failed) this.errors++;
    this.bytes += s.bytes;
    this.checksPassed += s.checksPassed;
    this.checksFailed += s.checksFailed;
    this.all.add(s.latencyMs);

    const key = this.names.has(s.name) || this.names.size < MAX_REQUEST_NAMES ? s.name : OTHER;
    let entry = this.names.get(key);
    if (!entry) this.names.set(key, (entry = { hist: new Histogram(), errors: 0 }));
    entry.hist.add(s.latencyMs);
    if (failed) entry.errors++;

    const status = s.status === null ? "error" : String(s.status);
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
    if (s.error) {
      const kind = s.error.slice(0, 200);
      if (this.errorKinds.has(kind) || this.errorKinds.size < MAX_ERROR_KINDS)
        this.errorKinds.set(kind, (this.errorKinds.get(kind) ?? 0) + 1);
    }

    const index = Math.floor(s.at / 1000 / this.bucketSec);
    let bucket = this.buckets.get(index);
    if (!bucket) this.buckets.set(index, (bucket = { hist: new Histogram(), errors: 0, vus: 0 }));
    bucket.hist.add(s.latencyMs);
    if (failed) bucket.errors++;
    bucket.vus = Math.max(bucket.vus, this.currentVus);
  }

  snapshot(elapsedSec: number): LoadSnapshot {
    const elapsed = Math.max(elapsedSec, 0.001);
    const series: SeriesPoint[] = [...this.buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, b]) => ({
        t: index * this.bucketSec,
        requests: b.hist.count,
        errors: b.errors,
        rps: round(b.hist.count / this.bucketSec),
        p50: round(b.hist.percentile(50)),
        p95: round(b.hist.percentile(95)),
        vus: b.vus,
      }));
    const checks = this.checksPassed + this.checksFailed;
    return {
      elapsedSec: round(elapsedSec),
      requests: this.requests,
      errors: this.errors,
      errorRate: this.requests ? this.errors / this.requests : 0,
      rps: round(this.requests / elapsed),
      bytes: this.bytes,
      checksPassed: this.checksPassed,
      checksFailed: this.checksFailed,
      checkFailRate: checks ? this.checksFailed / checks : 0,
      latency: stats(this.all),
      peakVus: this.peakVus,
      byRequest: [...this.names.entries()].map(([name, e]) => ({
        name,
        requests: e.hist.count,
        errors: e.errors,
        errorRate: e.hist.count ? e.errors / e.hist.count : 0,
        latency: stats(e.hist),
      })),
      statuses: Object.fromEntries([...this.statuses.entries()].sort()),
      errorKinds: [...this.errorKinds.entries()]
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count),
      series,
    };
  }
}

/** A time-series bucket width that keeps the series to about 300 points. */
export function bucketSecFor(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec / 300));
}
