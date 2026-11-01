/**
 * Deterministic failure simulations for mock servers: latency, errors, "fail the first N",
 * "fail every Nth", status sequences and rate limits. Counters are kept per mock, per session
 * and per scenario, so concurrent test sessions never affect each other, and the clock is
 * injected so behaviour is exactly reproducible. Pure: no database, no timers.
 */
import { z } from "zod";

export const MAX_SCENARIOS = 50;
export const MAX_SIMULATED_DELAY_MS = 30_000;
export const SESSION_HEADER = "x-mock-session";
export const DEFAULT_SESSION = "default";
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const errorStatus = z.number().int().min(400).max(599);
const body = z.string().max(8192).optional();
const contentType = z
  .string()
  .max(100)
  .regex(/^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w-]+=[\w.-]+)*$/, "Invalid content type")
  .optional();

const base = {
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  /** Limit to a method and/or path. Paths may use whole-segment :parameters. Omit to match everything. */
  match: z
    .object({
      method: z
        .string()
        .regex(/^[A-Za-z]{1,16}$/)
        .optional(),
      path: z.string().max(500).startsWith("/").optional(),
    })
    .default({}),
};

export const scenarioSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("delay"), ms: z.number().int().min(1).max(MAX_SIMULATED_DELAY_MS) }),
  z.object({ ...base, kind: z.literal("error"), status: errorStatus, body, contentType }),
  z.object({
    ...base,
    kind: z.literal("failFirst"),
    count: z.number().int().min(1).max(1000),
    status: errorStatus,
    body,
    contentType,
  }),
  z.object({
    ...base,
    kind: z.literal("failEvery"),
    every: z.number().int().min(2).max(1000),
    status: errorStatus,
    body,
    contentType,
  }),
  z.object({
    ...base,
    kind: z.literal("sequence"),
    /** One status per request, in order. 0 serves the matched example normally. */
    statuses: z
      .array(z.union([z.literal(0), z.number().int().min(200).max(599)]))
      .min(1)
      .max(50),
    /** Start again after the last entry; otherwise the last entry repeats. */
    repeat: z.boolean().default(true),
    body,
    contentType,
  }),
  z.object({
    ...base,
    kind: z.literal("rateLimit"),
    limit: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(1).max(86_400),
    status: errorStatus.default(429),
    body,
    contentType,
  }),
]);
export type Scenario = z.infer<typeof scenarioSchema>;
export const scenariosSchema = z
  .array(scenarioSchema)
  .max(MAX_SCENARIOS)
  .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "Scenario ids must be unique");

export interface ScenarioRequest {
  method: string;
  path: string;
}

export interface ScenarioOutcome {
  /** Extra latency before responding, summed over every scenario that ran (capped). */
  delayMs: number;
  /** Set when a scenario replaces the response. */
  failure?: {
    status: number;
    body: string;
    contentType: string;
    scenarioId: string;
    scenarioName: string;
    headers: [string, string][];
  };
  /** Headers to add to the response (rate-limit information). */
  headers: [string, string][];
}

interface Counter {
  seen: number;
  windowStart: number | null;
  windowCount: number;
}

const segments = (path: string) => path.split("/").map((s) => decodeURIComponent(s));

/** Whole-segment :parameters and {{variables}} match any non-empty segment; the rest must be equal. */
export function pathMatches(pattern: string, path: string): boolean {
  let expected: string[], actual: string[];
  try {
    expected = segments(pattern);
    actual = segments(path);
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return expected.every((segment, i) =>
    /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || /^\{\{[^{}]+\}\}$/.test(segment)
      ? actual[i].length > 0
      : segment === actual[i],
  );
}

export function scenarioApplies(scenario: Scenario, request: ScenarioRequest): boolean {
  if (!scenario.enabled) return false;
  const { method, path } = scenario.match;
  if (method && method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (path && !pathMatches(path, request.path)) return false;
  return true;
}

export function parseSession(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return DEFAULT_SESSION;
  return SESSION_PATTERN.test(value) ? value : null;
}

/** Counters for every (mock, session, scenario). Bounded, and sessions expire when idle. */
export class ScenarioState {
  private mocks = new Map<string, Map<string, { touched: number; counters: Map<string, Counter> }>>();
  constructor(private options: { maxSessionsPerMock?: number; idleMs?: number } = {}) {}

  private session(mockId: string, session: string, now: number) {
    const max = this.options.maxSessionsPerMock ?? 200;
    const idle = this.options.idleMs ?? 60 * 60 * 1000;
    let sessions = this.mocks.get(mockId);
    if (!sessions) this.mocks.set(mockId, (sessions = new Map()));
    for (const [name, s] of sessions) if (now - s.touched > idle) sessions.delete(name);
    let entry = sessions.get(session);
    if (entry)
      sessions.delete(session); // re-insert below so the oldest entry is the least recently used
    else entry = { touched: now, counters: new Map() };
    entry.touched = now;
    sessions.set(session, entry);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value!);
    return entry.counters;
  }

  counter(mockId: string, session: string, scenarioId: string, now: number): Counter {
    const counters = this.session(mockId, session, now);
    let c = counters.get(scenarioId);
    if (!c) counters.set(scenarioId, (c = { seen: 0, windowStart: null, windowCount: 0 }));
    return c;
  }

  /** Forget one session of a mock, or all of them. Returns how many sessions were cleared. */
  reset(mockId: string, session?: string): number {
    const sessions = this.mocks.get(mockId);
    if (!sessions) return 0;
    if (session === undefined) {
      const n = sessions.size;
      this.mocks.delete(mockId);
      return n;
    }
    return sessions.delete(session) ? 1 : 0;
  }

  sessionCount(mockId: string): number {
    return this.mocks.get(mockId)?.size ?? 0;
  }
}

const defaultBody = (scenario: string, status: number) =>
  JSON.stringify({ error: "Simulated failure", scenario, status });

/**
 * Run the scenarios that apply to a request, in order. A scenario that fails the request ends
 * evaluation: later scenarios do not see that request, so their counters only count requests
 * that reached them. Latency from the scenarios already evaluated still applies.
 */
export function evaluateScenarios(
  scenarios: readonly Scenario[],
  request: ScenarioRequest,
  state: ScenarioState,
  key: { mockId: string; session: string },
  now: number,
): ScenarioOutcome {
  const outcome: ScenarioOutcome = { delayMs: 0, headers: [] };
  for (const scenario of scenarios) {
    if (!scenarioApplies(scenario, request)) continue;
    const counter = state.counter(key.mockId, key.session, scenario.id, now);
    const n = ++counter.seen;
    const fail = (
      status: number,
      extra: { body?: string; contentType?: string } = {},
      headers: [string, string][] = [],
    ) => {
      outcome.failure = {
        status,
        body: extra.body ?? defaultBody(scenario.name, status),
        contentType:
          extra.contentType ?? (extra.body === undefined ? "application/json" : "text/plain; charset=utf-8"),
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        headers,
      };
    };
    switch (scenario.kind) {
      case "delay":
        outcome.delayMs = Math.min(MAX_SIMULATED_DELAY_MS, outcome.delayMs + scenario.ms);
        break;
      case "error":
        fail(scenario.status, scenario);
        break;
      case "failFirst":
        if (n <= scenario.count) fail(scenario.status, scenario);
        break;
      case "failEvery":
        if (n % scenario.every === 0) fail(scenario.status, scenario);
        break;
      case "sequence": {
        const last = scenario.statuses.length - 1;
        const index = scenario.repeat ? (n - 1) % scenario.statuses.length : Math.min(n - 1, last);
        const status = scenario.statuses[index];
        if (status !== 0) fail(status, scenario);
        break;
      }
      case "rateLimit": {
        const windowMs = scenario.windowSeconds * 1000;
        if (counter.windowStart === null || now - counter.windowStart >= windowMs) {
          counter.windowStart = now;
          counter.windowCount = 0;
        }
        counter.windowCount++;
        const resetSeconds = Math.max(1, Math.ceil((counter.windowStart + windowMs - now) / 1000));
        const remaining = Math.max(0, scenario.limit - counter.windowCount);
        const info: [string, string][] = [
          ["X-RateLimit-Limit", String(scenario.limit)],
          ["X-RateLimit-Remaining", String(remaining)],
          ["X-RateLimit-Reset", String(resetSeconds)],
        ];
        if (counter.windowCount > scenario.limit)
          fail(scenario.status, scenario, [...info, ["Retry-After", String(resetSeconds)]]);
        else outcome.headers.push(...info);
        break;
      }
    }
    if (outcome.failure) break;
  }
  return outcome;
}
