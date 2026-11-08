/**
 * Wire format between a Postbox server and a self-hosted runner (see docs/private-runners.md).
 * Pure: shared by the server routes and the `postbox runner start` agent.
 */
import { z } from "zod";

/** A job is leased for this long; the runner extends it with heartbeats. */
export const RUNNER_LEASE_MS = 60_000;
/** How many times a job is handed out (the first attempt included) before the check is recorded as failed. */
export const RUNNER_MAX_ATTEMPTS = 3;
/** A runner that has not called in for this long is shown as offline. */
export const RUNNER_ONLINE_MS = 90_000;
/** A job nobody picks up within this long is recorded as failed (the runner is offline). */
export const RUNNER_PENDING_MS = 5 * 60_000;

const count = z.number().int().min(0).max(1_000_000);
export const runnerResultSchema = z
  .object({
    status: z.enum(["passed", "failed", "cancelled", "error"]),
    timedOut: z.boolean().default(false),
    startedAt: z.number().int().positive(),
    finishedAt: z.number().int().positive(),
    metrics: z
      .object({
        requests: count,
        available: count,
        tests: count,
        passedTests: count,
        p95Ms: z.number().min(0).max(86_400_000).nullable(),
        availability: z.number().min(0).max(100),
        assertions: z.number().min(0).max(100).nullable(),
        scriptErrors: count,
      })
      .strict(),
    error: z.string().max(500).optional(),
  })
  .strict();
export type RunnerResult = z.infer<typeof runnerResultSchema>;

/** What the server sends when a runner leases a job. Secrets are blank unless the runner may hold them. */
export interface RunnerJob {
  jobId: string;
  runId: string;
  monitorId: string;
  attempt: number;
  name: string;
  /** Postman v2.1 collection and environment/globals exports. */
  collection: unknown;
  environment: unknown | null;
  globals: unknown | null;
  limits: { timeoutMs: number; maxDurationMs: number };
  policy: { allowHosts: string[]; denyHosts: string[] };
  leaseMs: number;
  /** True when this job carried secret values; false means the runner must supply them itself. */
  secretsIncluded: boolean;
}
