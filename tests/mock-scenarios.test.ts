import { describe, expect, it } from "vitest";
import {
  ScenarioState,
  evaluateScenarios,
  parseSession,
  pathMatches,
  scenariosSchema,
  type Scenario,
} from "@/core/mocks/scenarios";

const make = (list: unknown[]) => scenariosSchema.parse(list) as Scenario[];
const req = { method: "GET", path: "/users/1" };
const run = (scenarios: Scenario[], state: ScenarioState, session = "default", at = 0, r = req) =>
  evaluateScenarios(scenarios, r, state, { mockId: "m1", session }, at);
const statuses = (scenarios: Scenario[], times: number, state = new ScenarioState(), session = "default") =>
  Array.from({ length: times }, () => run(scenarios, state, session).failure?.status ?? 0);

describe("scenario engine", () => {
  it("fails the first N requests, then recovers", () => {
    const s = make([{ id: "a", name: "Flaky start", kind: "failFirst", count: 2, status: 503 }]);
    expect(statuses(s, 5)).toEqual([503, 503, 0, 0, 0]);
  });

  it("fails every Nth request", () => {
    const s = make([{ id: "a", name: "Every third", kind: "failEvery", every: 3, status: 500 }]);
    expect(statuses(s, 7)).toEqual([0, 0, 500, 0, 0, 500, 0]);
  });

  it("walks through a status sequence, where 0 means serve normally", () => {
    const list = { id: "a", name: "Sequence", kind: "sequence", statuses: [500, 0, 429] };
    expect(statuses(make([list]), 7)).toEqual([500, 0, 429, 500, 0, 429, 500]);
    expect(statuses(make([{ ...list, repeat: false }]), 6)).toEqual([500, 0, 429, 429, 429, 429]);
  });

  it("always fails with a fixed error, using a custom or default body", () => {
    const s = make([
      {
        id: "a",
        name: "Maintenance",
        kind: "error",
        status: 503,
        body: "down for maintenance",
        contentType: "text/plain",
      },
    ]);
    const f = run(s, new ScenarioState()).failure!;
    expect(f).toMatchObject({
      status: 503,
      body: "down for maintenance",
      contentType: "text/plain",
      scenarioId: "a",
    });
    const d = run(
      make([{ id: "b", name: "Boom", kind: "error", status: 500 }]),
      new ScenarioState(),
    ).failure!;
    expect(JSON.parse(d.body)).toEqual({ error: "Simulated failure", scenario: "Boom", status: 500 });
    expect(d.contentType).toBe("application/json");
  });

  it("enforces a rate limit in fixed windows on the injected clock", () => {
    const s = make([{ id: "rl", name: "Limit", kind: "rateLimit", limit: 2, windowSeconds: 10 }]);
    const state = new ScenarioState();
    const at = (ms: number) => run(s, state, "default", ms);
    const first = at(0);
    expect(first.failure).toBeUndefined();
    expect(Object.fromEntries(first.headers)).toEqual({
      "X-RateLimit-Limit": "2",
      "X-RateLimit-Remaining": "1",
      "X-RateLimit-Reset": "10",
    });
    expect(Object.fromEntries(at(3000).headers)["X-RateLimit-Remaining"]).toBe("0");
    const blocked = at(4000).failure!;
    expect(blocked.status).toBe(429);
    expect(Object.fromEntries(blocked.headers)).toMatchObject({
      "Retry-After": "6",
      "X-RateLimit-Remaining": "0",
    });
    // Still blocked just before the window ends, free again exactly at its end.
    expect(at(9999).failure?.status).toBe(429);
    expect(at(10_000).failure).toBeUndefined();
    expect(Object.fromEntries(at(10_001).headers)["X-RateLimit-Remaining"]).toBe("0");
    expect(at(10_002).failure?.status).toBe(429);
  });

  it("adds latency, keeps it when a later scenario fails, and caps the total", () => {
    const s = make([
      { id: "d1", name: "Slow", kind: "delay", ms: 200 },
      { id: "d2", name: "Slower", kind: "delay", ms: 300 },
      { id: "e", name: "Err", kind: "failFirst", count: 1, status: 502 },
    ]);
    const state = new ScenarioState();
    expect(run(s, state)).toMatchObject({ delayMs: 500, failure: { status: 502 } });
    const recovered = run(s, state);
    expect(recovered.delayMs).toBe(500);
    expect(recovered.failure).toBeUndefined();
    const huge = make(
      Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, name: "d", kind: "delay", ms: 20_000 })),
    );
    expect(run(huge, new ScenarioState()).delayMs).toBe(30_000);
  });

  it("stops at the first failure, so later counters only count requests that reached them", () => {
    const s = make([
      { id: "first", name: "First", kind: "failFirst", count: 2, status: 500 },
      { id: "second", name: "Second", kind: "failFirst", count: 1, status: 503 },
    ]);
    // Requests 1-2 are stopped by "first"; request 3 is the first one "second" sees.
    expect(statuses(s, 5)).toEqual([500, 500, 503, 0, 0]);
  });

  it("applies only to matching methods and paths, and skips disabled scenarios", () => {
    const s = make([
      {
        id: "a",
        name: "Users only",
        kind: "error",
        status: 500,
        match: { method: "post", path: "/users/:id" },
      },
      { id: "b", name: "Off", kind: "error", status: 500, enabled: false },
    ]);
    const state = new ScenarioState();
    expect(run(s, state, "default", 0, { method: "GET", path: "/users/1" }).failure).toBeUndefined();
    expect(run(s, state, "default", 0, { method: "POST", path: "/users/9" }).failure?.status).toBe(500);
    expect(run(s, state, "default", 0, { method: "POST", path: "/orders/9" }).failure).toBeUndefined();
    expect(pathMatches("/a/:x/c", "/a/b/c")).toBe(true);
    expect(pathMatches("/a/:x/c", "/a//c")).toBe(false);
    expect(pathMatches("/a/{{id}}", "/a/5")).toBe(true);
    expect(pathMatches("/a", "/a/b")).toBe(false);
    expect(pathMatches("/a%", "/a%")).toBe(false); // undecodable: never matches
  });
});

describe("sessions and reproducibility", () => {
  const s = make([{ id: "a", name: "Flaky", kind: "failFirst", count: 2, status: 500 }]);

  it("keeps sessions of the same mock independent, and mocks independent of each other", () => {
    const state = new ScenarioState();
    expect(statuses(s, 3, state, "alice")).toEqual([500, 500, 0]);
    expect(statuses(s, 3, state, "bob")).toEqual([500, 500, 0]);
    expect(evaluateScenarios(s, req, state, { mockId: "other", session: "alice" }, 0).failure?.status).toBe(
      500,
    );
    expect(statuses(s, 1, state, "alice")).toEqual([0]);
  });

  it("resets one session or a whole mock", () => {
    const state = new ScenarioState();
    statuses(s, 3, state, "alice");
    statuses(s, 3, state, "bob");
    expect(state.reset("m1", "alice")).toBe(1);
    expect(statuses(s, 3, state, "alice")).toEqual([500, 500, 0]);
    expect(statuses(s, 1, state, "bob")).toEqual([0]);
    expect(state.reset("m1")).toBe(2);
    expect(state.sessionCount("m1")).toBe(0);
    expect(state.reset("m1", "nobody")).toBe(0);
  });

  it("evicts the least recently used session and expires idle ones", () => {
    const state = new ScenarioState({ maxSessionsPerMock: 2, idleMs: 1000 });
    const hit = (session: string, at: number) =>
      evaluateScenarios(s, req, state, { mockId: "m1", session }, at).failure?.status ?? 0;
    hit("a", 0);
    hit("b", 1);
    hit("a", 2); // a is now the most recently used
    hit("c", 3); // evicts b
    expect(state.sessionCount("m1")).toBe(2);
    expect(hit("b", 4)).toBe(500); // b started over
    expect(hit("a", 5)).toBe(500); // a was evicted when b returned (max 2): it lost its count and fails first requests again
    // Idle sessions disappear.
    const idle = new ScenarioState({ idleMs: 1000 });
    evaluateScenarios(s, req, idle, { mockId: "m1", session: "x" }, 0);
    evaluateScenarios(s, req, idle, { mockId: "m1", session: "y" }, 5000);
    expect(idle.sessionCount("m1")).toBe(1);
  });

  it("produces identical results for identical request sequences", () => {
    const list = make([
      { id: "d", name: "Delay", kind: "delay", ms: 40 },
      { id: "e", name: "Every 4", kind: "failEvery", every: 4, status: 500 },
      { id: "r", name: "Rate", kind: "rateLimit", limit: 5, windowSeconds: 3 },
    ]);
    const play = () => {
      const state = new ScenarioState();
      return Array.from({ length: 30 }, (_, i) => run(list, state, "ci", i * 400));
    };
    expect(play()).toEqual(play());
  });

  it("validates session names", () => {
    expect(parseSession(null)).toBe("default");
    expect(parseSession("")).toBe("default");
    expect(parseSession("ci-run_42.a")).toBe("ci-run_42.a");
    for (const bad of ["a b", "a/b", "x".repeat(65), "é", "a\nb"]) expect(parseSession(bad)).toBeNull();
  });
});

describe("scenario validation", () => {
  const ok = { id: "a", name: "x", kind: "error", status: 500 };
  it("rejects unusable definitions", () => {
    const bad: unknown[] = [
      { ...ok, status: 200 },
      { ...ok, status: 600 },
      { ...ok, kind: "unknown" },
      { ...ok, name: "  " },
      { ...ok, contentType: "not a type" },
      { ...ok, body: "x".repeat(9000) },
      { ...ok, match: { path: "no-slash" } },
      { ...ok, match: { method: "G E T" } },
      { id: "a", name: "s", kind: "sequence", statuses: [] },
      { id: "a", name: "s", kind: "sequence", statuses: [100] },
      { id: "a", name: "s", kind: "failEvery", every: 1, status: 500 },
      { id: "a", name: "s", kind: "rateLimit", limit: 0, windowSeconds: 1 },
      { id: "a", name: "s", kind: "delay", ms: 31_000 },
    ];
    for (const entry of bad)
      expect(scenariosSchema.safeParse([entry]).success, JSON.stringify(entry)).toBe(false);
    expect(scenariosSchema.safeParse([ok, { ...ok }]).success).toBe(false); // duplicate ids
    expect(
      scenariosSchema.safeParse(Array.from({ length: 51 }, (_, i) => ({ ...ok, id: `s${i}` }))).success,
    ).toBe(false);
    expect(scenariosSchema.safeParse([ok]).success).toBe(true);
  });
});
