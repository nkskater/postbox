import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAD_LIMITS,
  describeProfile,
  profileDurationSec,
  profilePeakVus,
  profileSchema,
  profileViolations,
  targetVus,
} from "@/core/load/profile";
import { LoadMetrics, isError, bucketSecFor, type Sample } from "@/core/load/metrics";
import { evaluateThresholds, parseThreshold } from "@/core/load/thresholds";

describe("load profiles", () => {
  it("constant", () => {
    const p = profileSchema.parse({ type: "constant", vus: 5, durationSec: 10 });
    expect([targetVus(p, 0), targetVus(p, 9.9), targetVus(p, 10), targetVus(p, -1)]).toEqual([5, 5, 0, 0]);
    expect(profileDurationSec(p)).toBe(10);
    expect(describeProfile(p)).toBe("5 VUs for 10 s");
  });

  it("ramps linearly through stages", () => {
    const p = profileSchema.parse({
      type: "ramp",
      startVus: 0,
      stages: [
        { durationSec: 10, target: 10 },
        { durationSec: 20, target: 10 },
        { durationSec: 10, target: 0 },
      ],
    });
    expect([0, 5, 10, 20, 30, 35, 39.9].map((t) => targetVus(p, t))).toEqual([0, 5, 10, 10, 10, 5, 0]);
    expect(targetVus(p, 40)).toBe(0);
    expect(profilePeakVus(p)).toBe(10);
    expect(profileDurationSec(p)).toBe(40);
    expect(describeProfile(p)).toBe("ramp 0 → 10 → 10 → 0 VUs over 40 s");
    expect(profileSchema.parse({ type: "ramp", stages: [{ durationSec: 4, target: 8 }] })).toMatchObject({
      startVus: 0,
    });
  });

  it("spikes", () => {
    const p = profileSchema.parse({
      type: "spike",
      baseVus: 2,
      spikeVus: 20,
      durationSec: 30,
      spikeAtSec: 10,
      spikeForSec: 5,
    });
    expect([0, 9.9, 10, 14.9, 15, 29].map((t) => targetVus(p, t))).toEqual([2, 2, 20, 20, 2, 2]);
    expect(profilePeakVus(p)).toBe(20);
  });

  it("rejects invalid profiles and enforces ceilings", () => {
    expect(() => profileSchema.parse({ type: "constant", vus: 0, durationSec: 5 })).toThrow();
    expect(() => profileSchema.parse({ type: "constant", vus: 1, durationSec: 0 })).toThrow();
    expect(() => profileSchema.parse({ type: "ramp", stages: [] })).toThrow();
    expect(() =>
      profileSchema.parse({
        type: "spike",
        baseVus: 5,
        spikeVus: 2,
        durationSec: 10,
        spikeAtSec: 1,
        spikeForSec: 1,
      }),
    ).toThrow(/at least baseVus/);
    expect(() =>
      profileSchema.parse({
        type: "spike",
        baseVus: 1,
        spikeVus: 2,
        durationSec: 10,
        spikeAtSec: 8,
        spikeForSec: 5,
      }),
    ).toThrow(/end before/);
    expect(() => profileSchema.parse({ type: "nope" })).toThrow();
    const big = profileSchema.parse({ type: "constant", vus: 500, durationSec: 5000 });
    expect(profileViolations(big, DEFAULT_LOAD_LIMITS)).toHaveLength(2);
    expect(profileViolations(big, { ...DEFAULT_LOAD_LIMITS, maxVus: 1000, maxDurationSec: 9999 })).toEqual(
      [],
    );
  });
});

const sample = (over: Partial<Sample> = {}): Sample => ({
  at: 0,
  name: "A",
  latencyMs: 10,
  status: 200,
  error: null,
  bytes: 100,
  checksPassed: 0,
  checksFailed: 0,
  ...over,
});

describe("load metrics", () => {
  it("computes percentiles within one histogram bucket (about 1%)", () => {
    const m = new LoadMetrics();
    for (let i = 1; i <= 1000; i++) m.record(sample({ latencyMs: i }));
    const { latency } = m.snapshot(10);
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected) / expected).toBeLessThan(0.02);
    near(latency.p50, 500);
    near(latency.p90, 900);
    near(latency.p95, 950);
    near(latency.p99, 990);
    expect(latency).toMatchObject({ min: 1, max: 1000, avg: 500.5 });
  });

  it("counts errors, statuses, bytes, checks and throughput", () => {
    const m = new LoadMetrics();
    m.record(sample({ checksPassed: 2 }));
    m.record(sample({ status: 500, checksFailed: 1 }));
    m.record(sample({ status: null, error: "Connection refused by x:1", latencyMs: 3 }));
    m.record(sample({ status: 404, name: "B" }));
    const s = m.snapshot(2);
    expect(s).toMatchObject({
      requests: 4,
      errors: 3,
      errorRate: 0.75,
      rps: 2,
      bytes: 400,
      checksPassed: 2,
      checksFailed: 1,
    });
    expect(s.checkFailRate).toBeCloseTo(1 / 3);
    expect(s.statuses).toEqual({ "200": 1, "404": 1, "500": 1, error: 1 });
    expect(s.errorKinds).toEqual([{ message: "Connection refused by x:1", count: 1 }]);
    expect(s.byRequest.map((r) => [r.name, r.requests, r.errors])).toEqual([
      ["A", 3, 2],
      ["B", 1, 1],
    ]);
    expect(isError({ status: 399, error: null })).toBe(false);
    expect(isError({ status: 400, error: null })).toBe(true);
  });

  it("builds a bounded time series with VU counts", () => {
    const m = new LoadMetrics(2);
    m.setVus(3);
    m.record(sample({ at: 500 }));
    m.record(sample({ at: 1500, status: 500 }));
    m.setVus(7);
    m.record(sample({ at: 2500 }));
    expect(m.snapshot(4).series).toEqual([
      expect.objectContaining({ t: 0, requests: 2, errors: 1, rps: 1, vus: 3 }),
      expect.objectContaining({ t: 2, requests: 1, errors: 0, vus: 7 }),
    ]);
    expect(m.snapshot(4).peakVus).toBe(7);
    expect(bucketSecFor(60)).toBe(1);
    expect(bucketSecFor(3600)).toBe(12);
  });

  it("bounds the number of tracked request names and error kinds", () => {
    const m = new LoadMetrics();
    for (let i = 0; i < 300; i++) m.record(sample({ name: `r${i}`, status: null, error: `e${i}` }));
    const s = m.snapshot(1);
    expect(s.byRequest.length).toBe(101);
    expect(s.byRequest.at(-1)).toMatchObject({ name: "(other requests)", requests: 200 });
    expect(s.errorKinds.length).toBe(20);
    expect(s.requests).toBe(300);
  });

  it("handles an empty test", () => {
    expect(new LoadMetrics().snapshot(0)).toMatchObject({
      requests: 0,
      errorRate: 0,
      latency: { p95: 0, max: 0 },
    });
  });
});

describe("thresholds", () => {
  const m = new LoadMetrics();
  for (let i = 1; i <= 100; i++) m.record(sample({ latencyMs: i, name: "A" }));
  for (let i = 0; i < 100; i++) m.record(sample({ latencyMs: 500, name: "B", status: i < 10 ? 503 : 200 }));
  const snap = m.snapshot(10);

  it("parses shorthand", () => {
    expect(parseThreshold("p95<500")).toEqual({ metric: "p95", op: "<", value: 500 });
    expect(parseThreshold("errorRate <= 0.01")).toEqual({ metric: "errorRate", op: "<=", value: 0.01 });
    expect(parseThreshold("rps>=20@Create order")).toEqual({
      metric: "rps",
      op: ">=",
      value: 20,
      request: "Create order",
    });
    expect(() => parseThreshold("p95=5")).toThrow(/Invalid threshold/);
    expect(() => parseThreshold("bogus<5")).toThrow();
    expect(() => parseThreshold("p95<-5")).toThrow();
  });

  it("evaluates the whole test and single requests", () => {
    const results = evaluateThresholds(snap, [
      parseThreshold("p50<400"),
      parseThreshold("p95<400"),
      parseThreshold("errorRate<0.1"),
      parseThreshold("errorRate<=0.1@B"),
      parseThreshold("errorRate<0.01@A"),
      parseThreshold("p99<100@A"),
      parseThreshold("rps>=20"),
      parseThreshold("requests>=200"),
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false, true, true, true, true, true, true]);
    expect(results[1].actual).toBeGreaterThan(400);
    expect(results[6].actual).toBe(20);
  });

  it("fails when there is nothing to measure", () => {
    const res = evaluateThresholds(snap, [
      parseThreshold("p95<1@Missing"),
      parseThreshold("checkFailRate<1@A"),
    ]);
    expect(res.map((r) => [r.passed, r.actual])).toEqual([
      [false, null],
      [false, null],
    ]);
    expect(evaluateThresholds(new LoadMetrics().snapshot(1), [parseThreshold("p95<5")])[0].passed).toBe(
      false,
    );
  });
});
