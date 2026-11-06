import { createHash } from "node:crypto";
import { TELEMETRY_LIMITS, telemetryQuery, type StoredObservation, type TelemetryQuery } from "./model";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const endpointId = (
  item: Pick<StoredObservation, "sourceId" | "service" | "environment" | "method" | "route">,
) =>
  createHash("sha256")
    .update(JSON.stringify([item.sourceId, item.service, item.environment, item.method, item.route]))
    .digest("hex");
function distribution(items: readonly StoredObservation[]) {
  const durations = items.map((i) => i.durationMs).sort((a, b) => a - b),
    percentile = (p: number) =>
      durations.length ? durations[Math.max(0, Math.ceil(durations.length * p) - 1)] : null;
  const bounds = [10, 50, 100, 250, 500, 1000, 5000, Infinity],
    histogram = bounds.map((upper, i) => ({
      fromMs: i ? bounds[i - 1] : 0,
      toMs: Number.isFinite(upper) ? upper : null,
      count: 0,
    }));
  const statuses: Record<string, number> = {};
  let errors = 0;
  for (const item of items) {
    const bucket = histogram.find((b) => b.toMs === null || item.durationMs < b.toMs)!;
    bucket.count++;
    const key = item.status === null ? "unknown" : String(item.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    if (item.error) errors++;
  }
  return {
    sampledRequests: items.length,
    errors,
    errorRate: items.length ? (100 * errors) / items.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    histogram,
    statuses,
  };
}
export function aggregateTelemetry(raw: readonly StoredObservation[], query: TelemetryQuery) {
  const input = telemetryQuery.parse(query);
  if (raw.length > TELEMETRY_LIMITS.workspaceObservations)
    throw Error("Observation evaluation limit exceeded");
  const rows = raw.filter(
    (i) =>
      i.at >= input.from &&
      i.at < input.to &&
      (!input.sourceId || i.sourceId === input.sourceId) &&
      (!input.service || i.service === input.service) &&
      (!input.environment || i.environment === input.environment) &&
      (!input.search || i.route.toLowerCase().includes(input.search.toLowerCase())),
  );
  const groups = new Map<string, StoredObservation[]>();
  for (const item of rows) {
    const id = endpointId(item),
      items = groups.get(id) ?? [];
    items.push(item);
    groups.set(id, items);
  }
  const all = [...groups]
    .map(([id, items]) => {
      const first = items[0];
      return {
        id,
        sourceId: first.sourceId,
        service: first.service,
        environment: first.environment,
        method: first.method,
        route: first.route,
        firstSeen: Math.min(...items.map((i) => i.at)),
        lastSeen: Math.max(...items.map((i) => i.at)),
        ...distribution(items),
        routeSources: {
          template: items.filter((i) => i.routeSource === "template").length,
          path: items.filter((i) => i.routeSource === "path").length,
          unknown: items.filter((i) => i.routeSource === "unknown").length,
        },
        sampleRates: [...new Set(items.map((i) => i.sampleRate))].sort((a, b) => a - b),
      };
    })
    .filter((e) => !input.errorsOnly || e.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.sampledRequests - a.sampledRequests || compare(a.id, b.id));
  const selectedIds = new Set(all.map((e) => e.id)),
    selected = rows.filter((i) => selectedIds.has(endpointId(i)));
  const width = input.to - input.from,
    bucketMs = Math.max(1000, Math.ceil(width / 24 / 1000) * 1000),
    buckets: StoredObservation[][] = Array.from({ length: Math.ceil(width / bucketMs) }, () => []);
  for (const item of selected)
    buckets[Math.min(buckets.length - 1, Math.floor((item.at - input.from) / bucketMs))].push(item);
  return {
    from: input.from,
    to: input.to,
    ...distribution(selected),
    totalEndpoints: all.length,
    offset: input.offset,
    limit: input.limit,
    endpoints: all.slice(input.offset, input.offset + input.limit),
    timeline: buckets.map((items, i) => ({
      from: input.from + i * bucketMs,
      to: Math.min(input.to, input.from + (i + 1) * bucketMs),
      ...distribution(items),
    })),
  };
}
export function telemetryEndpoint(raw: readonly StoredObservation[], query: TelemetryQuery, id: string) {
  const summary = aggregateTelemetry(raw, { ...query, offset: 0, limit: 100 }),
    items = raw.filter(
      (i) =>
        endpointId(i) === id &&
        i.at >= query.from &&
        i.at < query.to &&
        (!query.sourceId || i.sourceId === query.sourceId) &&
        (!query.service || i.service === query.service) &&
        (!query.environment || i.environment === query.environment) &&
        (!query.search || i.route.toLowerCase().includes(query.search.toLowerCase())),
    );
  if (!items.length || (query.errorsOnly && !items.some((i) => i.error))) return null;
  const first = items[0];
  return {
    id,
    sourceId: first.sourceId,
    service: first.service,
    environment: first.environment,
    method: first.method,
    route: first.route,
    ...distribution(items),
    from: summary.from,
    to: summary.to,
    failedSpans: items
      .filter((i) => i.error)
      .sort((a, b) => b.at - a.at || compare(a.id, b.id))
      .slice(0, TELEMETRY_LIMITS.failedExamples),
  };
}
