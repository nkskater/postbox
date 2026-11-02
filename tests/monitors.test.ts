import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startSmtpFixture } from "./helpers/smtp-server";
import { monitorMetrics } from "@/core/monitoring/model";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-monitors-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const monitors = await import("@/server/monitors"),
  repo = await import("@/server/repo"),
  scheduler = await import("@/server/scheduler"),
  webhooks = await import("@/server/webhooks"),
  mail = await import("@/server/monitor-email");
const { getDb, getSqlite, schema } = await import("@/server/db");
let smtp: Awaited<ReturnType<typeof startSmtpFixture>>,
  server: http.Server,
  base: string,
  mode = "ok",
  hookFail = 0;
const deliveries: string[] = [];
beforeAll(async () => {
  smtp = await startSmtpFixture();
  Object.assign(process.env, {
    POSTBOX_SMTP_HOST: "127.0.0.1",
    POSTBOX_SMTP_PORT: String(smtp.port),
    POSTBOX_SMTP_FROM: "monitor@example.test",
    POSTBOX_SMTP_REQUIRE_TLS: "false",
  });
  mail.setMonitorEmailManual(true);
  webhooks.setWebhookWorkerManual(true);
  server = http.createServer((req, res) => {
    if (req.url === "/hook") {
      let body = "";
      req.on("data", (p) => (body += p));
      req.on("end", () => {
        deliveries.push(body);
        res.statusCode = hookFail-- > 0 ? 500 : 200;
        res.end("ok");
      });
      return;
    }
    if (req.url === "/hang") return;
    if (mode === "slow") {
      setTimeout(() => res.end("late"), 300);
      return;
    }
    res.statusCode = mode === "fail" ? 503 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  scheduler.stopScheduler();
  await smtp.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const ws = repo.createWorkspace("Monitor tests"),
    folder = repo.createFolder(ws.id, null, { name: "Watched API" });
  repo.createRequest(ws.id, folder.id, {
    name: "Health",
    url: base + "/api",
    testScript: 'pm.test("healthy",()=>pm.response.to.have.status(200));',
  });
  return {
    workspaceId: ws.id,
    folderId: folder.id,
    name: "Health monitor",
    cron: "0 0 1 1 *",
    enabled: false,
    rules: { minAvailability: 100, minAssertions: 100, failAfter: 2, recoverAfter: 2, timeoutMs: 100 },
    emails: ["alerts@example.test"],
  };
}
async function run(id: string) {
  const { runId } = await monitors.runMonitor(id);
  for (let i = 0; i < 200; i++) {
    const value = monitors.getMonitor(id);
    if (value.history.some((h) => h.runId === runId)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Monitor did not record completion");
}
describe("schedule-backed monitoring", () => {
  it("retains failure/recovery history, deduplicates incident events, retries webhook and SMTP with stable identifiers", async () => {
    const input = fixture(),
      monitor = monitors.createMonitor(input);
    const hook = webhooks.createWebhook(input.workspaceId, {
      name: "Monitor hook",
      url: base + "/hook",
      events: ["monitor.incident", "monitor.recovered"],
    });
    mode = "fail";
    expect((await run(monitor.id)).state).toBe("unknown");
    let value = await run(monitor.id);
    expect(value.state).toBe("incident");
    expect(value.incidents).toHaveLength(1);
    expect(value.emailsStatus).toHaveLength(1);
    await run(monitor.id);
    expect(monitors.getMonitor(monitor.id).incidents).toHaveLength(1);
    expect(webhooks.listDeliveries(hook.id)).toHaveLength(1);
    hookFail = 1;
    smtp.fail(1);
    const now = Date.now();
    await webhooks.processDue(now);
    await mail.processMonitorEmails(now);
    expect(webhooks.listDeliveries(hook.id)[0].status).toBe("pending");
    expect(monitors.getMonitor(monitor.id).emailsStatus[0].status).toBe("pending");
    const retryAt = Math.max(webhooks.listDeliveries(hook.id)[0].nextAttemptAt ?? 0, now + 10000) + 1;
    await webhooks.processDue(retryAt);
    await mail.processMonitorEmails(retryAt);
    expect(webhooks.listDeliveries(hook.id)[0].status).toBe("delivered");
    expect(monitors.getMonitor(monitor.id).emailsStatus[0].status).toBe("delivered");
    expect(smtp.messages[0].match(/Message-ID: ([^\r]+)/i)?.[1]).toBe(
      smtp.messages[1].match(/Message-ID: ([^\r]+)/i)?.[1],
    );
    expect(JSON.parse(deliveries[0]).id).toBe(JSON.parse(deliveries[1]).id);
    mode = "ok";
    expect((await run(monitor.id)).state).toBe("incident");
    value = await run(monitor.id);
    expect(value.state).toBe("healthy");
    expect(value.incidents[0].resolvedAt).not.toBeNull();
    expect(value.history).toHaveLength(5);
    expect(webhooks.listDeliveries(hook.id)).toHaveLength(2);
    const last = value.history[0];
    monitors.recordMonitorSample(monitor.id, last.runId, last.metrics, "passed");
    expect(monitors.getMonitor(monitor.id).history).toHaveLength(5);
    await mail.processMonitorEmails(now + 20000);
    expect(monitors.getMonitor(monitor.id).emailsStatus.every((e) => e.status === "delivered")).toBe(true);
  });
  it("records HTTP timeouts, applies retention without deleting pending mail or open incidents, and deletes attached data", async () => {
    const input = fixture(),
      monitor = monitors.createMonitor({ ...input, rules: { ...input.rules, failAfter: 1 } });
    mode = "slow";
    let value = await run(monitor.id);
    expect(value.state).toBe("incident");
    expect(value.history[0].metrics.availability).toBe(0);
    expect(value.history[0].metrics.requests).toBe(1);
    const future = Date.now() + 100 * 86400000;
    monitors.pruneMonitorHistory(1, future);
    value = monitors.getMonitor(monitor.id);
    expect(value.incidents).toHaveLength(1);
    expect(value.emailsStatus).toHaveLength(1);
    expect(value.history).toHaveLength(0);
    const id = monitor.id;
    monitors.deleteMonitor(id);
    expect(() => monitors.getMonitor(id)).toThrow();
    expect(
      getSqlite().prepare("SELECT count(*) AS n FROM monitor_samples WHERE monitor_id=?").get(id),
    ).toEqual({ n: 0 });
    expect(
      getSqlite().prepare("SELECT count(*) AS n FROM monitor_emails WHERE monitor_id=?").get(id),
    ).toEqual({ n: 0 });
    mode = "ok";
  });
  it("exhausts SMTP retries without duplicating records and supports an explicit retry", async () => {
    const input = fixture(),
      monitor = monitors.createMonitor({ ...input, rules: { ...input.rules, failAfter: 1 } });
    mode = "fail";
    await run(monitor.id);
    smtp.fail(6);
    let now = Date.now();
    for (let attempt = 0; attempt < 6; attempt++) {
      await mail.processMonitorEmails(now);
      const row = getDb()
        .select()
        .from(schema.monitorEmails)
        .all()
        .find((e) => e.monitorId === monitor.id)!;
      now = (row.nextAttemptAt ?? now) + 1;
    }
    let value = monitors.getMonitor(monitor.id);
    expect(value.emailsStatus).toHaveLength(1);
    expect(value.emailsStatus[0].status).toBe("failed");
    expect(value.emailsStatus[0].attempts).toBe(6);
    const id = value.emailsStatus[0].id;
    smtp.fail(0);
    monitors.retryMonitorEmail(monitor.id, id);
    await mail.processMonitorEmails(Date.now() + 1);
    value = monitors.getMonitor(monitor.id);
    expect(value.emailsStatus[0].id).toBe(id);
    expect(value.emailsStatus[0].status).toBe("delivered");
    expect(() => monitors.retryMonitorEmail(monitor.id, id)).toThrow("Only failed");
    monitors.deleteMonitor(monitor.id);
    mode = "ok";
  });
  it("enforces the whole-check deadline separately from the request timeout", async () => {
    const input = fixture();
    const request = repo.createRequest(input.workspaceId, input.folderId, {
      name: "Long delay",
      url: base + "/hang",
    });
    repo.deleteRequest(repo.getTreeSummary(input.workspaceId).requests.find((r) => r.id !== request.id)!.id);
    const monitor = monitors.createMonitor({
      ...input,
      rules: { ...input.rules, failAfter: 1, timeoutMs: 5000, maxDurationMs: 1000 },
    });
    const value = await run(monitor.id);
    expect(value.history[0].outcome).toBe("failed");
    expect(value.history[0].reasons).toContain("Monitor run timed out");
    monitors.deleteMonitor(monitor.id);
  });
  it("does not count shared-queue wait time as a monitor timeout", async () => {
    const runs = await import("@/server/runs");
    const holders = Array.from({ length: runs.runQueue.stats().maxActive }, () => runs.reserveRun());
    const input = fixture(),
      monitor = monitors.createMonitor({
        ...input,
        emails: [],
        rules: { ...input.rules, maxDurationMs: 1000 },
      });
    mode = "ok";
    try {
      const { runId } = await monitors.runMonitor(monitor.id);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(monitors.getMonitor(monitor.id).history).toHaveLength(0);
      for (const holder of holders) holder.release();
      for (let i = 0; i < 200; i++) {
        const history = monitors.getMonitor(monitor.id).history;
        if (history.some((h) => h.runId === runId)) {
          expect(history[0].outcome).toBe("passed");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(monitors.getMonitor(monitor.id).history).toHaveLength(1);
    } finally {
      for (const holder of holders) holder.release();
      monitors.deleteMonitor(monitor.id);
    }
  });
  it("retains a resolved incident while its notification emails are still pending", () => {
    const input = fixture(),
      monitor = monitors.createMonitor({
        ...input,
        rules: { ...input.rules, failAfter: 1, recoverAfter: 1 },
      }),
      at = Date.now() - 200 * 86400000;
    const bad = monitorMetrics([{ status: 503, timeMs: 20, skipped: false, tests: [{ passed: false }] }]),
      good = monitorMetrics([{ status: 200, timeMs: 20, skipped: false, tests: [{ passed: true }] }]);
    monitors.recordMonitorSample(monitor.id, "retention-fail-" + monitor.id, bad, "failed", false, at);
    monitors.recordMonitorSample(monitor.id, "retention-pass-" + monitor.id, good, "passed", false, at + 1);
    monitors.pruneMonitorHistory(1, Date.now());
    const value = monitors.getMonitor(monitor.id);
    expect(value.incidents).toHaveLength(1);
    expect(value.incidents[0].resolvedAt).not.toBeNull();
    expect(value.emailsStatus).toHaveLength(2);
    expect(value.emailsStatus.every((e) => e.status === "pending")).toBe(true);
    monitors.deleteMonitor(monitor.id);
  });
  it("paginates equal-time samples without gaps", () => {
    const input = fixture(),
      monitor = monitors.createMonitor({ ...input, emails: [] }),
      at = Date.now(),
      metrics = monitorMetrics([{ status: 200, timeMs: 1, skipped: false, tests: [] }]);
    getDb()
      .insert(schema.monitorSamples)
      .values(
        Array.from({ length: 501 }, (_, i) => ({
          id: `cursor-${monitor.id}-${String(i).padStart(3, "0")}`,
          monitorId: monitor.id,
          runId: `cursor-run-${monitor.id}-${i}`,
          at,
          outcome: "passed",
          metrics,
          reasons: [],
        })),
      )
      .run();
    const first = monitors.getMonitor(monitor.id);
    expect(first.history).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    const next = monitors.getMonitor(monitor.id, 168, first.nextBefore!);
    expect(next.history).toHaveLength(1);
    expect(next.history[0].id.endsWith("000")).toBe(true);
    expect(next.hasMore).toBe(false);
    monitors.deleteMonitor(monitor.id);
  });
  it("backs up monitor configuration and restores it paused without replaying incidents or email", async () => {
    const input = fixture(),
      monitor = monitors.createMonitor({ ...input, enabled: true, rules: { ...input.rules, failAfter: 1 } });
    mode = "fail";
    await run(monitor.id);
    const backup = await import("@/server/backup"),
      saved = backup.createBackup(getDb(), { includeSecrets: false });
    expect(saved.tables.monitors.some((m) => m.id === monitor.id)).toBe(true);
    backup.restoreBackup(getDb(), getSqlite(), saved);
    const value = monitors.getMonitor(monitor.id);
    expect(value.enabled).toBe(false);
    expect(value.state).toBe("unknown");
    expect(value.rules.failAfter).toBe(1);
    expect(value.history).toHaveLength(0);
    expect(value.incidents).toHaveLength(0);
    expect(value.emailsStatus).toHaveLength(0);
    monitors.deleteMonitor(monitor.id);
    mode = "ok";
  });
  it("uses revisions, validates references and policies, and persists only bounded numeric telemetry", () => {
    const input = fixture(),
      monitor = monitors.createMonitor(input);
    expect(() => monitors.updateMonitor(monitor.id, { name: "Conflict", expectedRevision: 2 })).toThrow(
      "changed",
    );
    const changed = monitors.updateMonitor(monitor.id, { name: "Updated", expectedRevision: 1 });
    expect(changed.revision).toBe(2);
    expect(() => monitors.createMonitor({ ...input, folderId: "missing" })).toThrow();
    const metrics = monitorMetrics([{ status: 200, timeMs: 20, skipped: false, tests: [{ passed: true }] }]);
    monitors.recordMonitorSample(monitor.id, "synthetic", metrics, "passed");
    const value = monitors.getMonitor(monitor.id);
    expect(JSON.stringify(value.history)).not.toContain(base);
    expect(value.history[0].metrics.p95Ms).toBe(20);
    expect(
      getDb()
        .select()
        .from(schema.monitorEmails)
        .all()
        .every((e) => !e.body.includes("password")),
    ).toBe(true);
  });
});
