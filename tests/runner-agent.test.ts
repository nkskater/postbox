import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AgentAuthError, policyFor, runAgent, type LocalConfig } from "@/core/runner-agent/agent";
import type { RunnerJob } from "@/core/runner-agent/protocol";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-runner-agent-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const runners = await import("@/server/runners"),
  monitors = await import("@/server/monitors"),
  repo = await import("@/server/repo"),
  scheduler = await import("@/server/scheduler"),
  lease = await import("@/app/api/runner-agent/lease/route"),
  heartbeat = await import("@/app/api/runner-agent/jobs/[id]/heartbeat/route"),
  result = await import("@/app/api/runner-agent/jobs/[id]/result/route");
const { getSqlite } = await import("@/server/db");

let target: http.Server;
let base: string;
const hits: { url: string; auth: string | undefined }[] = [];
beforeAll(async () => {
  target = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", auth: req.headers["x-api-key"] as string | undefined });
    res.setHeader("content-type", "application/json");
    res.statusCode = req.url === "/down" ? 503 : 200;
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
afterAll(async () => {
  scheduler.stopScheduler();
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const local: LocalConfig = { variables: {}, allowHosts: [], denyHosts: [] };

/** A fetch that talks to the route handlers directly, with hooks to simulate a flaky network. */
function transport(hooks: { dropFirstResultAck?: boolean; twice?: boolean } = {}) {
  let dropped = false;
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const request = () => new Request(href, init);
    calls.push(href.split("/api/runner-agent/")[1]);
    const jobMatch = /jobs\/([^/]+)\/(heartbeat|result)$/.exec(href);
    if (href.endsWith("/lease")) return lease.POST(request());
    const context = { params: Promise.resolve({ id: jobMatch![1] }) };
    if (jobMatch![2] === "heartbeat") return heartbeat.POST(request(), context);
    const first = await result.POST(request(), context);
    if (hooks.twice) await result.POST(request(), context);
    if (hooks.dropFirstResultAck && !dropped) {
      dropped = true;
      throw new TypeError("connection reset");
    }
    return first;
  }) as typeof fetch;
  return { fn, calls };
}

function setup(path_ = "/ok", rules: Record<string, unknown> = { failAfter: 1, recoverAfter: 1 }) {
  const ws = repo.createWorkspace(`Agent ws ${Math.random()}`);
  const folder = repo.createFolder(ws.id, null, { name: "Intranet" });
  repo.createRequest(ws.id, folder.id, {
    name: "Health",
    url: `${base}${path_}`,
    headers: [{ key: "x-api-key", value: "{{apiKey}}", enabled: true }],
    testScript: 'pm.test("up",()=>pm.response.to.have.status(200));',
  });
  repo.replaceVariables(ws.id, "collection", folder.id, [
    { key: "apiKey", value: "server-side-secret", type: "secret", enabled: true },
  ]);
  const runner = runners.createRunner({ workspaceId: ws.id, name: "branch-office", location: "Lisbon" });
  const monitor = monitors.createMonitor({
    workspaceId: ws.id,
    folderId: folder.id,
    name: "Intranet health",
    cron: "0 0 1 1 *",
    enabled: false,
    runnerId: runner.id,
    rules: rules as never,
  });
  return { ws, runner, monitor };
}

describe("private runner agent", () => {
  it("runs a queued check inside its own network and reports where it ran", async () => {
    const { runner, monitor } = setup();
    await monitors.runMonitor(monitor.id);
    const { fn } = transport();
    const outcome = await runAgent({
      server: "http://postbox.test",
      token: runner.token,
      version: "9.9.9",
      local: { ...local, variables: { apiKey: "runner-local-secret" } },
      once: true,
      fetch: fn,
    });
    expect(outcome.jobs).toBe(1);
    const value = monitors.getMonitor(monitor.id);
    expect(value.history).toHaveLength(1);
    expect(value.history[0]).toMatchObject({ outcome: "passed", runnerId: runner.id });
    expect(value.history[0].metrics).toMatchObject({ requests: 1, available: 1, tests: 1, passedTests: 1 });
    expect(value.runner).toMatchObject({ name: "branch-office", location: "Lisbon" });
    // The server's secret never travelled; the runner's own value was used.
    expect(hits.at(-1)!.auth).toBe("runner-local-secret");
    expect(runners.getRunner(runner.id)).toMatchObject({ version: "9.9.9", status: "online" });
  });

  it("records a failing check and opens an incident", async () => {
    const { runner, monitor } = setup("/down");
    await monitors.runMonitor(monitor.id);
    await runAgent({
      server: "http://postbox.test",
      token: runner.token,
      version: "1",
      local,
      once: true,
      fetch: transport().fn,
    });
    const value = monitors.getMonitor(monitor.id);
    expect(value.history[0].outcome).toBe("failed");
    expect(value.state).toBe("incident");
  });

  it("survives a lost acknowledgement: the retried result is recorded exactly once", async () => {
    const { runner, monitor } = setup();
    await monitors.runMonitor(monitor.id);
    const { fn, calls } = transport({ dropFirstResultAck: true });
    const waits: number[] = [];
    await runAgent({
      server: "http://postbox.test",
      token: runner.token,
      version: "1",
      local,
      once: true,
      fetch: fn,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(calls.filter((c) => c.endsWith("/result"))).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(1);
  });

  it("ignores a duplicate delivery of the same result", async () => {
    const { runner, monitor } = setup();
    await monitors.runMonitor(monitor.id);
    await runAgent({
      server: "http://postbox.test",
      token: runner.token,
      version: "1",
      local,
      once: true,
      fetch: transport({ twice: true }).fn,
    });
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(1);
  });

  it("stops with a clear error when the token is wrong or revoked", async () => {
    const { runner } = setup();
    const bad = runAgent({
      server: "http://postbox.test",
      token: "pbr_" + "z".repeat(43),
      version: "1",
      local,
      once: true,
      fetch: transport().fn,
    });
    await expect(bad).rejects.toBeInstanceOf(AgentAuthError);
    runners.revokeRunner(runner.id);
    await expect(
      runAgent({
        server: "http://postbox.test",
        token: runner.token,
        version: "1",
        local,
        once: true,
        fetch: transport().fn,
      }),
    ).rejects.toThrow(/refused this runner/);
  });

  it("keeps retrying while the server is unreachable and exits cleanly with --once", async () => {
    const { runner } = setup();
    let attempts = 0;
    const unreachable = (async () => {
      attempts++;
      throw new TypeError("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      runAgent({
        server: "http://postbox.test",
        token: runner.token,
        version: "1",
        local,
        once: true,
        fetch: unreachable,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(attempts).toBe(3);
  });

  it("combines the server and local host rules", () => {
    const job = { policy: { allowHosts: [], denyHosts: ["169.254.169.254"] } } as unknown as RunnerJob;
    const policy = policyFor(job, { variables: {}, allowHosts: ["*.corp.test"], denyHosts: ["10.9.9.9"] });
    expect(policy.check("api.corp.test")).toBeNull();
    expect(policy.check("evil.example")).not.toBeNull();
    expect(policy.check("10.9.9.9")).not.toBeNull();
    expect(policy.check("169.254.169.254")).not.toBeNull();
    const server = { policy: { allowHosts: ["only.test"], denyHosts: [] } } as unknown as RunnerJob;
    expect(
      policyFor(server, { variables: {}, allowHosts: ["*.corp.test"], denyHosts: [] }).check("api.corp.test"),
    ).not.toBeNull();
  });

  it("enforces the runner's host policy against the collection", async () => {
    const { ws } = setup();
    const runner = runners.createRunner({
      workspaceId: ws.id,
      name: "locked",
      allowHosts: ["only-this.example"],
    });
    const folder = repo.createFolder(ws.id, null, { name: "Locked" });
    repo.createRequest(ws.id, folder.id, { name: "Out", url: `${base}/ok` });
    const monitor = monitors.createMonitor({
      workspaceId: ws.id,
      folderId: folder.id,
      name: "Locked",
      cron: "0 0 1 1 *",
      enabled: false,
      runnerId: runner.id,
    });
    await monitors.runMonitor(monitor.id);
    await runAgent({
      server: "http://postbox.test",
      token: runner.token,
      version: "1",
      local,
      once: true,
      fetch: transport().fn,
    });
    const value = monitors.getMonitor(monitor.id);
    expect(value.history[0].outcome).toBe("failed");
    expect(value.history[0].metrics.available).toBe(0);
  });
});
