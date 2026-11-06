import { describe, it, expect } from "vitest";
import { telemetryConfig, telemetryQuery, type StoredObservation } from "@/core/telemetry/model";
import { decodeTelemetry, telemetryRoute, sampled } from "@/core/telemetry/otlp";
import { aggregateTelemetry, telemetryEndpoint, endpointId } from "@/core/telemetry/metrics";
import { span, batch, attr } from "./fixtures/telemetry/traffic";
const now = Date.now(),
  config = telemetryConfig.parse({ name: "Production", serviceName: "checkout" });
const decode = (spans: unknown[]) => decodeTelemetry(batch(spans), config, now);
const rows = (durations = [10, 20, 30, 40, 500]): StoredObservation[] =>
  durations.map((duration, i) => ({
    ...decode([span(i + 1, now - i * 1000, duration, i === 4 ? 500 : 200)]).observations[0],
    id: String(i),
    sourceId: "source",
    sourceRevision: 1,
  }));
const query = () => telemetryQuery.parse({ from: now - 60000, to: now + 1 });
describe("OTLP metadata connector", () => {
  it("defaults to disabled intake and validates bounded configuration", () => {
    expect(config.enabled).toBe(false);
    for (const extra of [
      { sampleRate: 2 },
      { retentionDays: 31 },
      { maxObservations: 5001 },
      { staticSegments: ["private/path"] },
    ])
      expect(telemetryConfig.safeParse({ ...config, ...extra }).success).toBe(false);
  });
  it("normalizes IDs and persists only approved server HTTP metadata", () => {
    const data = decode([span(171, now, 123, 503)]);
    expect(data.counts).toMatchObject({ received: 1, rejected: 0 });
    expect(data.observations[0]).toMatchObject({
      route: "/api/users/:id",
      durationMs: 123,
      error: true,
      status: 503,
      service: "checkout",
      environment: "production",
      routeSource: "template",
    });
    expect(JSON.stringify(data.observations)).not.toContain("SECRET");
    expect(
      decode([{ ...span(), traceId: "A".repeat(32), spanId: "B".repeat(16) }]).observations[0].traceId,
    ).toBe("a".repeat(32));
  });
  it("redacts arbitrary segments, encoded identifiers, URLs, query and parameter names", () => {
    for (const route of [
      "/api/users/alice@example.com?secret=SECRET",
      "https://user:SECRET@example.test/api/users/alice@example.com#SECRET",
      "/api/users/%61lice%40example.com",
    ])
      expect(telemetryRoute(route, config.staticSegments)).toBe("/api/users/:segment");
    expect(telemetryRoute("/api/users/{secretId}/123/abcdefabcdefabcdef", config.staticSegments)).toBe(
      "/api/users/:id/:id/:id",
    );
    expect(telemetryRoute("/billing/checkout", ["billing", "checkout"])).toBe("/billing/checkout");
    expect(telemetryRoute("/a/%ZZ", [])).toBe("/:segment/:segment");
  });
  it("supports legacy HTTP attributes and infers a route without storing the raw path", () => {
    const s = span();
    s.attributes = [
      attr("http.method", "POST"),
      attr("http.status_code", "404"),
      attr("http.url", "https://secret.test/orders/123?q=SECRET"),
    ];
    expect(decode([s]).observations[0]).toMatchObject({
      method: "POST",
      status: 404,
      error: true,
      route: "/orders/:id",
      routeSource: "path",
    });
  });
  it("ignores other services, client spans, enum strings and non-HTTP spans", () => {
    expect(decodeTelemetry(batch([span()], "other"), config, now).counts.ignored).toBe(1);
    expect(
      decode([
        { ...span(), kind: 3 },
        { ...span(), kind: "SPAN_KIND_SERVER" },
        { ...span(), attributes: [] },
      ]).counts.ignored,
    ).toBe(3);
  });
  it("rejects invalid IDs, timestamps, attributes and statuses without poisoning valid siblings", () => {
    const data = decode([
      { ...span(), traceId: "0".repeat(32) },
      { ...span(), spanId: "bad" },
      { ...span(), startTimeUnixNano: "-1" },
      span(3, now - 8 * 86400000),
      span(4, now + 180000),
      span(5, now, 3600001),
      { ...span(), attributes: [attr("http.method", "GET"), attr("http.status_code", 999)] },
      { ...span(), attributes: Array.from({ length: 129 }, () => attr("a", "b")) },
      span(),
    ]);
    expect(data.counts.rejected).toBe(8);
    expect(data.observations).toHaveLength(1);
  });
  it("accepts empty requests and enforces batch structural limits", () => {
    expect(decodeTelemetry({}, config, now).observations).toEqual([]);
    for (const raw of [null, [], { resourceSpans: {} }, batch(Array.from({ length: 1001 }, () => span()))])
      expect(() => decodeTelemetry(raw, config, now)).toThrow();
  });
  it("samples deterministically on identity, including exact zero and one", () => {
    const one = span();
    expect(sampled(one.traceId, one.spanId, 1)).toBe(true);
    expect(sampled(one.traceId, one.spanId, 0)).toBe(false);
    expect(sampled(one.traceId, one.spanId, 0.25)).toBe(sampled(one.traceId, one.spanId, 0.25));
    const result = decodeTelemetry(
      batch(Array.from({ length: 1000 }, (_, i) => span(i + 1, now))),
      { ...config, sampleRate: 0.5 },
      now,
    );
    expect(result.observations.length).toBeGreaterThan(400);
    expect(result.observations.length).toBeLessThan(600);
    expect(result.counts.sampledOut + result.observations.length).toBe(1000);
  });
});
describe("sampled endpoint metrics", () => {
  it("calculates exact nearest-rank percentiles, histogram, errors and timeline", () => {
    const result = aggregateTelemetry(rows(), query());
    expect(result).toMatchObject({
      sampledRequests: 5,
      errors: 1,
      errorRate: 20,
      p50Ms: 30,
      p95Ms: 500,
      p99Ms: 500,
      totalEndpoints: 1,
    });
    expect(result.histogram.reduce((n, b) => n + b.count, 0)).toBe(5);
    expect(result.timeline.reduce((n, b) => n + b.sampledRequests, 0)).toBe(5);
    expect(result.endpoints[0].routeSources).toEqual({ template: 5, path: 0, unknown: 0 });
  });
  it("keeps source attribution separate and filters endpoints with errors using the full denominator", () => {
    const raw = [...rows(), { ...rows([50])[0], id: "new", sourceId: "other" }];
    expect(aggregateTelemetry(raw, query()).totalEndpoints).toBe(2);
    expect(aggregateTelemetry(raw, { ...query(), errorsOnly: true })).toMatchObject({
      sampledRequests: 5,
      errorRate: 20,
      totalEndpoints: 1,
    });
    expect(aggregateTelemetry(raw, { ...query(), sourceId: "other" })).toMatchObject({
      sampledRequests: 1,
      errorRate: 0,
    });
    expect(aggregateTelemetry(raw, { ...query(), service: "other" }).sampledRequests).toBe(0);
  });
  it("returns unknown empty metrics and enforces half-open bounded windows and pagination", () => {
    expect(aggregateTelemetry([], query())).toMatchObject({
      errorRate: null,
      p50Ms: null,
      totalEndpoints: 0,
    });
    expect(aggregateTelemetry(rows(), { ...query(), to: now }).sampledRequests).toBe(4);
    expect(aggregateTelemetry(rows(), { ...query(), offset: 1 }).endpoints).toEqual([]);
    expect(() => telemetryQuery.parse({ from: now, to: now + 31 * 86400000 })).toThrow();
  });
  it("returns at most 20 failed metadata examples scoped to filters", () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({
      ...rows()[4],
      id: String(i),
      spanId: String(i),
      at: now - i,
    }));
    const id = endpointId(raw[0]);
    expect(telemetryEndpoint(raw, query(), id)?.failedSpans).toHaveLength(20);
    expect(telemetryEndpoint(raw, { ...query(), environment: "other" }, id)).toBeNull();
  });
});
