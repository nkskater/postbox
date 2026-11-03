import { z } from "zod";
export const SCORECARD_LIMITS = { cards: 50, versions: 100, bindings: 200, reports: 50 } as const;
export const measure = z.enum([
  "availability",
  "assertions",
  "latency",
  "tests",
  "scriptErrors",
  "governanceErrors",
  "governanceWarnings",
  "governancePassRate",
  "description",
  "ownership",
  "publishedAgeHours",
]);
export type Measure = z.infer<typeof measure>;
const key = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/);
export const metric = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(120),
    measure,
    weight: z.number().positive().max(1000),
    good: z.number().finite().min(0).max(1e9),
    bad: z.number().finite().min(0).max(1e9),
    maxAgeHours: z.number().positive().max(2160).default(24),
  })
  .strict()
  .refine((v) => v.good !== v.bad, "Good and bad values must differ");
export const scorecardConfig = z
  .object({
    formatVersion: z.literal(1),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    thresholds: z
      .object({ healthy: z.number().min(0).max(100), attention: z.number().min(0).max(100) })
      .strict()
      .refine((v) => v.healthy > v.attention, "Healthy must exceed attention"),
    unavailable: z.enum(["zero", "exclude"]).default("zero"),
    minimumCoverage: z.number().min(0).max(100).default(100),
    categories: z
      .array(
        z
          .object({
            id: key,
            name: z.string().trim().min(1).max(120),
            weight: z.number().positive().max(1000),
            metrics: z.array(metric).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.categories.map((c) => c.id),
      metrics = v.categories.flatMap((c) => c.metrics.map((m) => m.id));
    if (new Set(ids).size !== ids.length || new Set(metrics).size !== metrics.length)
      ctx.addIssue({ code: "custom", message: "Category and metric IDs must be unique" });
    if (metrics.length > 50 || new TextEncoder().encode(JSON.stringify(v)).length > 64 * 1024)
      ctx.addIssue({ code: "custom", message: "At most 50 metrics and 64 KiB of configuration" });
  });
export type ScorecardConfig = z.infer<typeof scorecardConfig>;
export interface Fact {
  value: number | null;
  observedAt: number | null;
  state: "available" | "unavailable" | "stale";
  reason: string;
  source: { kind: "catalog" | "monitor" | "governance"; id: string; version: string } | null;
}
export type Facts = Partial<Record<Measure, Fact>>;
export type QualityStatus = "healthy" | "attention" | "critical" | "unknown";
export const DEFAULT_SCORECARD = scorecardConfig.parse({
  formatVersion: 1,
  name: "API quality",
  thresholds: { healthy: 90, attention: 70 },
  categories: [
    {
      id: "runtime",
      name: "Runtime and tests",
      weight: 50,
      metrics: [
        {
          id: "availability",
          name: "Availability (%)",
          measure: "availability",
          weight: 50,
          good: 100,
          bad: 90,
        },
        {
          id: "assertions",
          name: "Passing assertions (%)",
          measure: "assertions",
          weight: 30,
          good: 100,
          bad: 80,
        },
        { id: "latency", name: "p95 latency (ms)", measure: "latency", weight: 20, good: 200, bad: 2000 },
      ],
    },
    {
      id: "specification",
      name: "Specification governance",
      weight: 30,
      metrics: [
        {
          id: "governance-errors",
          name: "Governance errors",
          measure: "governanceErrors",
          weight: 100,
          good: 0,
          bad: 10,
        },
      ],
    },
    {
      id: "catalog",
      name: "Catalog readiness",
      weight: 20,
      metrics: [
        {
          id: "description",
          name: "Service description",
          measure: "description",
          weight: 50,
          good: 1,
          bad: 0,
          maxAgeHours: 2160,
        },
        {
          id: "ownership",
          name: "Named owners",
          measure: "ownership",
          weight: 50,
          good: 1,
          bad: 0,
          maxAgeHours: 2160,
        },
      ],
    },
  ],
});
