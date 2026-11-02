import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LoadConfigError, runLoad, type LoadEvent, type LoadInput } from "@/core/load/runner";
import { parseThreshold } from "@/core/load/thresholds";
import { emptyScopes } from "@/core/variables/resolver";
import { DEFAULT_SETTINGS, type FolderNode, type RequestDef, type RequestNode } from "@/core/types";

let server: http.Server;
let base = "";
let inflight = 0;
let maxInflight = 0;
let total = 0;
const seen: { path: string; user: string | undefined; n: string | null }[] = [];
const reset = () => {
  maxInflight = 0;
  total = 0;
  seen.length = 0;
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    inflight++;
    total++;
    maxInflight = Math.max(maxInflight, inflight);
    seen.push({
      path: url.pathname,
      user: req.headers["x-user"] as string | undefined,
      n: url.searchParams.get("n"),
    });
    const finish = (status: number, body = "ok") => {
      setTimeout(
        () => {
          inflight--;
          res.writeHead(status, { "Content-Type": "text/plain" });
          res.end(body);
        },
        url.pathname === "/slow" ? 40 : 5,
      );
    };
    if (url.pathname === "/fail") return finish(503, "down");
    finish(200);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const request = (name: string, path: string, extra: Partial<RequestDef> = {}): RequestNode => ({
  kind: "request",
  id: `r-${name}`,
  name,
  method: "GET",
  url: `${base}${path}`,
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...extra,
});
const tree = (...children: FolderNode["children"]): FolderNode => ({
  kind: "folder",
  id: "root",
  name: "Load",
  auth: { type: "none" },
  headers: [],
  preRequestScript: "",
  testScript: "",
  children,
});
const input = (root: FolderNode, over: Partial<LoadInput> = {}): LoadInput => ({
  root,
  scopes: emptyScopes(),
  profile: { type: "constant", vus: 3, durationSec: 1 },
  thinkMs: 10,
  ...over,
});

describe("load runner", () => {
  it("runs a constant load and reports throughput, latency and VUs", async () => {
    reset();
    const events: LoadEvent[] = [];
    const result = await runLoad(
      input(tree(request("Slow", "/slow")), {
        profile: { type: "constant", vus: 4, durationSec: 2 },
        onEvent: (e) => events.push(e),
        progressMs: 500,
      }),
    );
    const s = result.snapshot;
    expect(result.status).toBe("passed");
    expect(s.peakVus).toBe(4);
    expect(s.requests).toBe(total);
    expect(s.requests).toBeGreaterThan(30);
    expect(s.errors).toBe(0);
    expect(maxInflight).toBeGreaterThanOrEqual(3);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(s.latency.p50).toBeGreaterThanOrEqual(35);
    expect(s.latency.p50).toBeLessThan(500);
    expect(s.latency.p99).toBeGreaterThanOrEqual(s.latency.p50);
    expect(s.rps).toBeGreaterThan(15);
    expect(s.statuses).toEqual({ "200": s.requests });
    expect(s.series.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ type: "start" });
    expect(events.filter((e) => e.type === "progress").length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(result.durationMs).toBeGreaterThanOrEqual(1900);
    expect(result.durationMs).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 300));
    const after = total;
    await new Promise((r) => setTimeout(r, 300));
    expect(total).toBe(after); // nothing keeps running after the test ends
    expect(inflight).toBe(0);
  }, 20000);

  it("ramps users up and down", async () => {
    reset();
    const result = await runLoad(
      input(tree(request("Slow", "/slow")), {
        profile: {
          type: "ramp",
          startVus: 0,
          stages: [
            { durationSec: 2, target: 6 },
            { durationSec: 1, target: 0 },
          ],
        },
      }),
    );
    expect(result.snapshot.peakVus).toBeGreaterThanOrEqual(5);
    expect(result.snapshot.peakVus).toBeLessThanOrEqual(6);
    expect(maxInflight).toBeLessThanOrEqual(6);
    const vus = result.snapshot.series.map((p) => p.vus);
    expect(vus[0]).toBeLessThanOrEqual(3);
    expect(Math.max(...vus)).toBeGreaterThanOrEqual(5);
    expect(result.snapshot.errors).toBe(0);
    expect(inflight).toBe(0);
  }, 20000);

  it("spikes above the base load", async () => {
    reset();
    const result = await runLoad(
      input(tree(request("Slow", "/slow")), {
        profile: { type: "spike", baseVus: 1, spikeVus: 6, durationSec: 3, spikeAtSec: 1, spikeForSec: 1 },
      }),
    );
    expect(result.snapshot.peakVus).toBe(6);
    expect(maxInflight).toBeGreaterThanOrEqual(5);
    const base = result.snapshot.series.filter((p) => p.t === 0)[0];
    const spike = result.snapshot.series.filter((p) => p.t === 1)[0];
    expect(spike.requests).toBeGreaterThan(base.requests * 2);
  }, 20000);

  it("counts HTTP and transport errors separately by request", async () => {
    reset();
    const result = await runLoad(
      input(
        tree(request("Good", "/ok"), request("Bad", "/fail"), {
          ...request("Dead", ""),
          url: "http://127.0.0.1:1/x",
        }),
      ),
    );
    const s = result.snapshot;
    const by = Object.fromEntries(s.byRequest.map((r) => [r.name, r]));
    expect(by.Good.errors).toBe(0);
    expect(by.Bad.errorRate).toBe(1);
    expect(by.Dead.errorRate).toBe(1);
    expect(s.statuses["503"]).toBe(by.Bad.requests);
    expect(s.statuses.error).toBe(by.Dead.requests);
    expect(s.errorKinds[0].message).toMatch(/refused|ECONNREFUSED/i);
    expect(s.errorRate).toBeGreaterThan(0.5);
  }, 20000);

  it("evaluates thresholds into pass or fail", async () => {
    const run = (thresholds: string[], path = "/ok") =>
      runLoad(
        input(tree(request("A", path)), {
          profile: { type: "constant", vus: 2, durationSec: 1 },
          thresholds: thresholds.map(parseThreshold),
        }),
      );
    const ok = await run(["p95<1000", "errorRate<0.01", "rps>=5@A"]);
    expect(ok.status).toBe("passed");
    expect(ok.thresholds.every((t) => t.passed)).toBe(true);
    const bad = await run(["errorRate<0.01", "p95<1000"], "/fail");
    expect(bad.status).toBe("failed");
    expect(bad.thresholds.map((t) => t.passed)).toEqual([false, true]);
  }, 20000);

  it("isolates variables, data rows and cookies per virtual user", async () => {
    reset();
    const root = tree(
      request("Count", "/count?n={{n}}", {
        headers: [{ key: "X-User", value: "{{user}}", enabled: true }],
        preRequestScript: 'pm.environment.set("n", String(Number(pm.environment.get("n") || 0) + 1));',
      }),
    );
    await runLoad(
      input(root, {
        profile: { type: "constant", vus: 3, durationSec: 3 },
        data: { columns: ["user"], rows: [{ user: "u0" }, { user: "u1" }, { user: "u2" }] },
        thinkMs: 20,
      }),
    );
    const byUser = new Map<string, number[]>();
    for (const s of seen.filter((s) => s.path === "/count"))
      byUser.set(s.user ?? "?", [...(byUser.get(s.user ?? "?") ?? []), Number(s.n)]);
    expect([...byUser.keys()].sort()).toEqual(["u0", "u1", "u2"]);
    for (const [, counts] of byUser) {
      expect(counts.length).toBeGreaterThan(2);
      // Each user's counter runs 1, 2, 3, ... without being touched by the others.
      expect(counts).toEqual(counts.map((_, i) => i + 1));
    }
  }, 20000);

  it("stops promptly when cancelled", async () => {
    reset();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 600);
    const started = Date.now();
    const result = await runLoad(
      input(tree(request("Slow", "/slow")), {
        profile: { type: "constant", vus: 3, durationSec: 60 },
        signal: ctrl.signal,
      }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.status).toBe("cancelled");
    expect(result.stoppedBy).toBe("cancelled");
    expect(result.snapshot.requests).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(inflight).toBe(0);
    // A signal that is already aborted never sends anything.
    reset();
    const early = new AbortController();
    early.abort();
    const r2 = await runLoad(input(tree(request("Slow", "/slow")), { signal: early.signal }));
    expect(r2.status).toBe("cancelled");
    expect(total).toBe(0);
  }, 20000);

  it("stops at the request ceiling", async () => {
    reset();
    const result = await runLoad(
      input(tree(request("A", "/ok")), {
        profile: { type: "constant", vus: 5, durationSec: 30 },
        limits: { maxRequests: 25 },
        thinkMs: 0,
      }),
    );
    expect(result.stoppedBy).toBe("maxRequests");
    expect(result.snapshot.requests).toBeGreaterThanOrEqual(25);
    expect(result.snapshot.requests).toBeLessThanOrEqual(30);
    expect(result.durationMs).toBeLessThan(5000);
  }, 20000);

  it("refuses profiles beyond the ceilings and empty selections", async () => {
    reset();
    await expect(
      runLoad(input(tree(request("A", "/ok")), { profile: { type: "constant", vus: 500, durationSec: 1 } })),
    ).rejects.toBeInstanceOf(LoadConfigError);
    await expect(
      runLoad(input(tree(request("A", "/ok")), { profile: { type: "constant", vus: 1, durationSec: 5000 } })),
    ).rejects.toThrow(/limit is 600 s/);
    await expect(runLoad(input(tree()))).rejects.toThrow(/no requests/);
    await expect(runLoad(input(tree(request("A", "/ok")), { selectedRequestIds: ["nope"] }))).rejects.toThrow(
      /no requests/,
    );
    expect(total).toBe(0);
  });

  it("runs only the selected requests", async () => {
    reset();
    await runLoad(input(tree(request("A", "/a"), request("B", "/b")), { selectedRequestIds: ["r-B"] }));
    expect(new Set(seen.map((s) => s.path))).toEqual(new Set(["/b"]));
  }, 20000);
});
