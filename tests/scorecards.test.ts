import { describe, expect, it } from "vitest";
import { scorecardConfig, type Fact, type ScorecardConfig } from "@/core/scorecards/model";
import { compareEvaluations, evaluateScorecard, summarizeEvaluations } from "@/core/scorecards/evaluate";
const at = 1_800_000_000_000;
const fact = (value: number, age = 0): Fact => ({
  value,
  observedAt: at - age,
  state: "available",
  reason: "Fixture",
  source: { kind: "monitor", id: "monitor", version: "sample1" },
});
const config = (extra: Partial<ScorecardConfig> = {}) =>
  scorecardConfig.parse({
    formatVersion: 1,
    name: "Quality",
    thresholds: { healthy: 80, attention: 50 },
    categories: [
      {
        id: "runtime",
        name: "Runtime",
        weight: 3,
        metrics: [
          { id: "availability", name: "Availability", measure: "availability", weight: 3, good: 100, bad: 0 },
          { id: "latency", name: "Latency", measure: "latency", weight: 1, good: 0, bad: 1000 },
        ],
      },
      {
        id: "spec",
        name: "Specification",
        weight: 1,
        metrics: [{ id: "errors", name: "Errors", measure: "governanceErrors", weight: 1, good: 0, bad: 10 }],
      },
    ],
    ...extra,
  });
describe("weighted scorecards", () => {
  it("normalizes category and metric weights and supports increasing/decreasing targets", () => {
    const result = evaluateScorecard(
      config(),
      { availability: fact(100), latency: fact(1000), governanceErrors: fact(5) },
      at,
    );
    expect(result.categories.map((c) => c.score)).toEqual([75, 50]);
    expect(result.score).toBe(68.75);
    expect(result.coverage).toBe(100);
    expect(result.status).toBe("attention");
    expect(
      evaluateScorecard(
        config(),
        { availability: fact(150), latency: fact(-50), governanceErrors: fact(0) },
        at,
      ).score,
    ).toBe(100);
  });
  it("shows missing data and weighted coverage without reporting a clean result", () => {
    const result = evaluateScorecard(config(), { availability: fact(100) }, at);
    expect(result.coverage).toBe(56.25);
    expect(result.score).toBe(56.25);
    expect(result.status).toBe("unknown");
    expect(result.categories[0].metrics[1]).toMatchObject({ score: null, state: "unavailable" });
    expect(evaluateScorecard(config({ minimumCoverage: 0 }), {}, at)).toMatchObject({
      score: null,
      status: "unknown",
      coverage: 0,
    });
  });
  it("excludes missing values only when explicitly configured and still reports partial coverage", () => {
    expect(
      evaluateScorecard(config({ unavailable: "exclude" }), { availability: fact(100) }, at),
    ).toMatchObject({ score: 100, coverage: 56.25, status: "unknown" });
  });
  it("marks expired, future, nonfinite and explicitly stale sources without scoring them", () => {
    const expired = evaluateScorecard(
      config(),
      {
        availability: fact(100, 25 * 3600000),
        latency: { ...fact(0), state: "stale", reason: "Source changed" },
        governanceErrors: fact(0, -1000),
      },
      at,
    );
    expect(expired.categories.flatMap((c) => c.metrics).map((m) => m.state)).toEqual([
      "stale",
      "stale",
      "unavailable",
    ]);
    expect(expired.score).toBeNull();
    expect(evaluateScorecard(config(), { availability: fact(NaN) }, at).categories[0].metrics[0].state).toBe(
      "unavailable",
    );
    expect(
      evaluateScorecard(config(), { availability: fact(100, 24 * 3600000) }, at).categories[0].metrics[0]
        .state,
    ).toBe("available");
  });
  it("evaluates threshold boundaries before display rounding", () => {
    const one = config({
      categories: [
        {
          id: "only",
          name: "Only",
          weight: 1,
          metrics: [
            { id: "up", name: "Up", measure: "availability", weight: 1, good: 100, bad: 0, maxAgeHours: 24 },
          ],
        },
      ],
    });
    expect(evaluateScorecard(one, { availability: fact(79.999) }, at)).toMatchObject({
      score: 80,
      status: "attention",
    });
    expect(evaluateScorecard(one, { availability: fact(80) }, at).status).toBe("healthy");
    expect(evaluateScorecard(one, { availability: fact(49.99) }, at).status).toBe("critical");
  });
  it("is deterministic and compares metrics by stable identity rather than display order", () => {
    const before = evaluateScorecard(
        config(),
        { availability: fact(60), latency: fact(500), governanceErrors: fact(5) },
        at,
      ),
      after = evaluateScorecard(
        config(),
        { availability: fact(100), latency: fact(500), governanceErrors: fact(5) },
        at,
      );
    expect(compareEvaluations(before, after)).toMatchObject({ scoreDelta: 22.5, coverageDelta: 0 });
    expect(
      evaluateScorecard(
        config(),
        { availability: fact(60), latency: fact(500), governanceErrors: fact(5) },
        at,
      ),
    ).toEqual(before);
    const changed = config();
    changed.categories[0].metrics[0].good = 120;
    expect(
      compareEvaluations(before, evaluateScorecard(changed, { availability: fact(100) }, at)).metrics[0],
    ).toMatchObject({ comparable: false, delta: null });
  });
  it("includes entirely unavailable services as zero in portfolio scoring unless exclusion is explicit", () => {
    const policy = config(),
      healthy = evaluateScorecard(
        policy,
        { availability: fact(100), latency: fact(0), governanceErrors: fact(0) },
        at,
      ),
      missing = evaluateScorecard(policy, {}, at);
    expect(summarizeEvaluations([healthy, missing], policy)).toMatchObject({
      score: 50,
      coverage: 50,
      status: "unknown",
      services: 2,
    });
    expect(summarizeEvaluations([healthy, missing], { ...policy, unavailable: "exclude" })).toMatchObject({
      score: 100,
      coverage: 50,
      status: "unknown",
    });
    expect(summarizeEvaluations([], policy)).toMatchObject({
      score: null,
      coverage: 0,
      status: "unknown",
      services: 0,
    });
  });
  it("rejects invalid weights, ambiguous targets, duplicate identifiers and invalid thresholds", () => {
    for (const modify of [
      (c: ScorecardConfig) => (c.categories[0].weight = 0),
      (c: ScorecardConfig) => (c.categories[0].metrics[0].bad = 100),
      (c: ScorecardConfig) => (c.categories[1].metrics[0].id = "availability"),
      (c: ScorecardConfig) => (c.thresholds.attention = 90),
      (c: ScorecardConfig) => (c.categories[0].metrics[0].maxAgeHours = 0),
    ]) {
      const value = config();
      modify(value);
      expect(scorecardConfig.safeParse(value).success).toBe(false);
    }
  });
});
