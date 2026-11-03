import { scorecardConfig, type Facts, type Fact, type QualityStatus, type ScorecardConfig } from "./model";
const round = (v: number) => Math.round(v * 100) / 100;
export function qualityStatus(
  score: number | null,
  coverage: number,
  config: ScorecardConfig,
): QualityStatus {
  if (score === null || coverage < config.minimumCoverage) return "unknown";
  return score >= config.thresholds.healthy
    ? "healthy"
    : score >= config.thresholds.attention
      ? "attention"
      : "critical";
}
/** A missing source never becomes a successful check. Coverage remains visible even when excluded. */
export function evaluateScorecard(raw: ScorecardConfig, facts: Facts, at: number) {
  const config = scorecardConfig.parse(raw);
  if (!Number.isFinite(at) || at < 0) throw Error("Invalid evaluation time");
  let weighted = 0,
    denominator = 0,
    covered = 0,
    total = 0;
  const categories = config.categories.map((category) => {
    let scoreSum = 0,
      scoreWeight = 0,
      availableWeight = 0;
    const weight = category.metrics.reduce((n, m) => n + m.weight, 0);
    const metrics = category.metrics.map((metric) => {
      const fact: Fact = facts[metric.measure] ?? {
        value: null,
        observedAt: null,
        state: "unavailable",
        reason: "Source is not configured",
        source: null,
      };
      let state = fact.state,
        reason = fact.reason;
      if (state === "available") {
        if (
          fact.value === null ||
          !Number.isFinite(fact.value) ||
          fact.observedAt === null ||
          !Number.isFinite(fact.observedAt) ||
          fact.observedAt > at
        ) {
          state = "unavailable";
          reason = "Source value or timestamp is unavailable";
        } else if (at - fact.observedAt > metric.maxAgeHours * 3600000) {
          state = "stale";
          reason = "Source exceeds this metric's freshness limit";
        }
      }
      const available = state === "available";
      const score = available
        ? Math.max(0, Math.min(100, (100 * (fact.value! - metric.bad)) / (metric.good - metric.bad)))
        : null;
      if (available) {
        availableWeight += metric.weight;
        scoreSum += score! * metric.weight;
      }
      if (available || config.unavailable === "zero") scoreWeight += metric.weight;
      return {
        id: metric.id,
        name: metric.name,
        measure: metric.measure,
        weight: metric.weight,
        good: metric.good,
        bad: metric.bad,
        maxAgeHours: metric.maxAgeHours,
        value: fact.value,
        observedAt: fact.observedAt,
        source: fact.source,
        state,
        reason,
        score: score === null ? null : round(score),
      };
    });
    const score = scoreWeight ? scoreSum / scoreWeight : null,
      coverage = (100 * availableWeight) / weight;
    covered += (category.weight * availableWeight) / weight;
    total += category.weight;
    if (score !== null) {
      weighted += score * category.weight;
      denominator += category.weight;
    }
    return {
      id: category.id,
      name: category.name,
      weight: category.weight,
      score: score === null ? null : round(score),
      coverage: round(coverage),
      status: qualityStatus(score, coverage, config),
      metrics,
    };
  });
  const coverage = total ? (100 * covered) / total : 0;
  const anyAvailable = categories.some((c) => c.metrics.some((m) => m.state === "available"));
  const score = anyAvailable && denominator ? weighted / denominator : null;
  return {
    score: score === null ? null : round(score),
    coverage: round(coverage),
    status: qualityStatus(score, coverage, config),
    categories,
  };
}
export type Evaluation = ReturnType<typeof evaluateScorecard>;
export function compareEvaluations(before: Evaluation, after: Evaluation) {
  return {
    scoreDelta: before.score === null || after.score === null ? null : round(after.score - before.score),
    coverageDelta: round(after.coverage - before.coverage),
    before: before.status,
    after: after.status,
    metrics: after.categories
      .flatMap((c) => c.metrics)
      .map((metric) => {
        const old = before.categories.flatMap((c) => c.metrics).find((m) => m.id === metric.id);
        const comparable =
          !!old &&
          old.measure === metric.measure &&
          old.good === metric.good &&
          old.bad === metric.bad &&
          old.weight === metric.weight &&
          old.maxAgeHours === metric.maxAgeHours;
        return {
          id: metric.id,
          comparable,
          before: old?.score ?? null,
          after: metric.score,
          delta:
            comparable && old?.score !== null && metric.score !== null
              ? round(metric.score - old!.score!)
              : null,
        };
      }),
  };
}

/** Service/environment slices carry equal weight in the portfolio summary. */
export function summarizeEvaluations(evaluations: Evaluation[], config: ScorecardConfig) {
  const available = evaluations.flatMap((e) => (e.score === null ? [] : [e.score]));
  const denominator = config.unavailable === "zero" ? evaluations.length : available.length;
  const score = available.length && denominator ? available.reduce((a, b) => a + b, 0) / denominator : null;
  const coverage = evaluations.length
    ? evaluations.reduce((n, e) => n + e.coverage, 0) / evaluations.length
    : 0;
  return {
    services: evaluations.length,
    score: score === null ? null : round(score),
    coverage: round(coverage),
    status: qualityStatus(score, coverage, config),
    counts: Object.fromEntries(
      ["healthy", "attention", "critical", "unknown"].map((state) => [
        state,
        evaluations.filter((e) => e.status === state).length,
      ]),
    ),
  };
}
