import { and, asc, desc, eq, gte, lt, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  monitorRulesSchema,
  monitorMetrics,
  checkMonitor,
  monitorTransition,
  type MonitorMetrics,
} from "@/core/monitoring/model";
import type { RunSummary } from "@/core/runner/runner";
import { getDb, getSqlite, schema } from "./db";
import { resolveSettings } from "@/lib/settings/registry";
import { readSavedSettings } from "./settings";
import { newId } from "./defaults";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedule,
  cancelScheduleExecution,
} from "./scheduler";
import { emitEvent } from "./webhooks";
import { smtpConfiguration, startMonitorEmailWorker } from "./monitor-email";
const { monitors, monitorSamples, monitorIncidents, monitorEmails, schedules, runResults } = schema;
export const monitorInput = z
  .object({
    workspaceId: z.string().min(1),
    folderId: z.string().min(1),
    environmentId: z.string().nullable().default(null),
    name: z.string().trim().min(1).max(200),
    cron: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    rules: monitorRulesSchema.default(() => monitorRulesSchema.parse({})),
    emails: z.array(z.email().max(254)).max(10).default([]),
  })
  .strict();
export const monitorPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    folderId: z.string().min(1).optional(),
    environmentId: z.string().nullable().optional(),
    cron: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    rules: monitorRulesSchema.optional(),
    emails: z.array(z.email().max(254)).max(10).optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export function requireMonitor(id: string, action: "read" | "write" | "run" = "read") {
  const row = getDb().select().from(monitors).where(eq(monitors.id, id)).get();
  if (!row) throw new HttpError(404, "Monitor not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
function mailStatus() {
  try {
    return !!smtpConfiguration();
  } catch {
    return false;
  }
}
function describe(row: typeof monitors.$inferSelect) {
  const schedule = getDb().select().from(schedules).where(eq(schedules.id, row.scheduleId)).get()!;
  return {
    ...row,
    name: schedule.name,
    folderId: schedule.folderId,
    environmentId: schedule.environmentId,
    enabled: schedule.enabled,
    cron: schedule.cron,
    lastRunId: schedule.lastRunId,
    lastRunAt: schedule.lastRunAt,
    smtpConfigured: mailStatus(),
  };
}
export function listMonitors(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(monitors)
    .where(eq(monitors.workspaceId, workspaceId))
    .orderBy(asc(monitors.createdAt))
    .all()
    .map(describe);
}
export function getMonitor(id: string, hours = 168, before?: string) {
  let cursor: { at: number; id: string } | undefined;
  if (before) {
    const [at, id, ...extra] = before.split(":");
    if (
      extra.length ||
      !/^\d+$/.test(at) ||
      !Number.isSafeInteger(Number(at)) ||
      !id ||
      !/^[A-Za-z0-9_-]+$/.test(id)
    )
      throw new HttpError(400, "Invalid monitor history cursor");
    cursor = { at: Number(at), id };
  }
  const row = requireMonitor(id);
  if (!Number.isFinite(hours) || hours < 1 || hours > 2160) throw new HttpError(400, "hours must be 1..2160");
  const since = Date.now() - hours * 3600000;
  const history = getDb()
    .select()
    .from(monitorSamples)
    .where(
      and(
        eq(monitorSamples.monitorId, id),
        gte(monitorSamples.at, since),
        cursor
          ? or(
              lt(monitorSamples.at, cursor.at),
              and(eq(monitorSamples.at, cursor.at), lt(monitorSamples.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(monitorSamples.at), desc(monitorSamples.id))
    .limit(501)
    .all();
  const hasMore = history.length > 500;
  if (hasMore) history.pop();
  const aggregate = getSqlite()
    .prepare(
      `SELECT count(*) AS checks, sum(CASE WHEN outcome='passed' THEN 1 ELSE 0 END) AS passed, sum(json_extract(metrics,'$.requests')) AS requests, sum(json_extract(metrics,'$.available')) AS available, sum(json_extract(metrics,'$.tests')) AS tests, sum(json_extract(metrics,'$.passedTests')) AS passedTests FROM monitor_samples WHERE monitor_id=? AND at>=? AND outcome!='skipped'`,
    )
    .get(id, since) as {
    checks: number;
    passed: number;
    requests: number;
    available: number;
    tests: number;
    passedTests: number;
  };
  return {
    ...describe(row),
    history,
    hasMore,
    nextBefore: hasMore ? `${history.at(-1)!.at}:${history.at(-1)!.id}` : null,
    aggregate,
    incidents: getDb()
      .select()
      .from(monitorIncidents)
      .where(eq(monitorIncidents.monitorId, id))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(100)
      .all(),
    emailsStatus: getDb()
      .select({
        id: monitorEmails.id,
        kind: monitorEmails.kind,
        recipient: monitorEmails.recipient,
        status: monitorEmails.status,
        attempts: monitorEmails.attempts,
        lastError: monitorEmails.lastError,
        createdAt: monitorEmails.createdAt,
      })
      .from(monitorEmails)
      .where(eq(monitorEmails.monitorId, id))
      .orderBy(desc(monitorEmails.createdAt))
      .limit(50)
      .all(),
  };
}
export function createMonitor(raw: z.input<typeof monitorInput>) {
  const input = monitorInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  if (listMonitors(input.workspaceId).length >= 50)
    throw new HttpError(429, "At most 50 monitors per workspace");
  if (input.emails.length && !mailStatus())
    throw new HttpError(400, "Configure the server SMTP relay before enabling email notifications");
  const schedule = createSchedule({
    workspaceId: input.workspaceId,
    folderId: input.folderId,
    environmentId: input.environmentId,
    name: input.name,
    cron: input.cron,
    enabled: input.enabled,
    options: { iterations: 1, timeoutMs: input.rules.timeoutMs, persistVariables: false },
  });
  const id = newId(),
    now = Date.now();
  getDb()
    .insert(monitors)
    .values({
      id,
      workspaceId: input.workspaceId,
      scheduleId: schedule.id,
      rules: input.rules,
      emails: [...new Set(input.emails.map((e) => e.toLowerCase()))],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getMonitor(id);
}
export function updateMonitor(id: string, raw: z.input<typeof monitorPatch>) {
  const current = requireMonitor(id, "write"),
    patch = monitorPatch.parse(raw);
  if (current.revision !== patch.expectedRevision)
    throw new HttpError(409, "Monitor changed; reload before saving");
  if (patch.emails?.length && !mailStatus()) throw new HttpError(400, "SMTP is not configured");
  const { expectedRevision, rules, emails, ...schedule } = patch;
  getDb().transaction(() => {
    updateSchedule(current.scheduleId, {
      ...schedule,
      ...(rules ? { options: { iterations: 1, timeoutMs: rules.timeoutMs, persistVariables: false } } : {}),
    });
    getDb()
      .update(monitors)
      .set({
        ...(rules ? { rules } : {}),
        ...(emails ? { emails: [...new Set(emails.map((e) => e.toLowerCase()))] } : {}),
        revision: expectedRevision + 1,
        updatedAt: Date.now(),
        ...(rules ? { failures: 0, successes: 0 } : {}),
      })
      .where(eq(monitors.id, id))
      .run();
  });
  return getMonitor(id);
}
export function deleteMonitor(id: string) {
  const row = requireMonitor(id, "write");
  cancelScheduleExecution(row.scheduleId);
  deleteSchedule(row.scheduleId);
  return { ok: true };
}
export async function runMonitor(id: string) {
  const row = requireMonitor(id, "run");
  return runSchedule(row.scheduleId);
}
export function monitorExecution(scheduleId: string) {
  const row = getDb().select().from(monitors).where(eq(monitors.scheduleId, scheduleId)).get();
  return row ? { timeoutMs: row.rules.timeoutMs, maxDurationMs: row.rules.maxDurationMs } : null;
}
function queueEmails(
  row: typeof monitors.$inferSelect,
  incidentId: string,
  kind: string,
  name: string,
  reasons: string[],
  now: number,
) {
  const pending =
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(monitorEmails)
      .where(and(eq(monitorEmails.monitorId, row.id), eq(monitorEmails.status, "pending")))
      .get()?.count ?? 0;
  for (const [index, recipient] of row.emails.entries())
    getDb()
      .insert(monitorEmails)
      .values({
        id: newId(),
        monitorId: row.id,
        incidentId,
        kind,
        recipient,
        subject: `[Postbox] ${kind === "monitor.incident" ? "Incident" : "Recovered"}: ${name}`.slice(0, 300),
        body: `Monitor: ${name}\nState: ${kind}\n${reasons.join("\n")}\nIncident: ${incidentId}\n`,
        nextAttemptAt: pending + index >= 1000 ? null : now,
        status: pending + index >= 1000 ? "failed" : "pending",
        lastError: pending + index >= 1000 ? "Email queue limit reached" : null,
        createdAt: now,
        finishedAt: pending + index >= 1000 ? now : null,
      })
      .onConflictDoNothing()
      .run();
}
export function recordMonitorRun(scheduleId: string, runId: string, summary: RunSummary, timedOut = false) {
  const db = getDb();
  const row = db.select().from(monitors).where(eq(monitors.scheduleId, scheduleId)).get();
  if (!row) return;
  const results = db
    .select({
      status: runResults.status,
      timeMs: runResults.timeMs,
      skipped: runResults.skipped,
      tests: runResults.tests,
      scriptErrors: runResults.scriptErrors,
    })
    .from(runResults)
    .where(eq(runResults.runId, runId))
    .all();
  recordMonitorSample(row.id, runId, monitorMetrics(results), summary.status, timedOut, summary.finishedAt);
}
export function recordMonitorSample(
  id: string,
  runId: string,
  metrics: MonitorMetrics,
  status: string,
  timedOut = false,
  at = Date.now(),
) {
  const db = getDb();
  db.transaction(() => {
    const row = db.select().from(monitors).where(eq(monitors.id, id)).get();
    if (
      !row ||
      db.select({ id: monitorSamples.id }).from(monitorSamples).where(eq(monitorSamples.runId, runId)).get()
    )
      return;
    const checked = checkMonitor(row.rules, metrics, status, timedOut),
      next = monitorTransition(row, checked.outcome, row.rules);
    db.insert(monitorSamples)
      .values({
        id: newId(),
        monitorId: id,
        runId,
        at,
        outcome: checked.outcome,
        metrics,
        reasons: checked.reasons,
      })
      .run();
    let incidentId = row.openIncidentId;
    const schedule = db.select().from(schedules).where(eq(schedules.id, row.scheduleId)).get()!;
    if (next.event === "monitor.incident") {
      incidentId = newId();
      db.insert(monitorIncidents)
        .values({
          id: incidentId,
          monitorId: id,
          startedAt: at,
          reasons: checked.reasons,
          openingRunId: runId,
        })
        .run();
    }
    if (next.event === "monitor.recovered" && incidentId)
      db.update(monitorIncidents)
        .set({ resolvedAt: at, recoveryRunId: runId })
        .where(eq(monitorIncidents.id, incidentId))
        .run();
    if (next.event && incidentId) {
      const data = {
        monitorId: id,
        monitorName: schedule.name,
        incidentId,
        runId,
        state: next.state,
        metrics,
        reasons: checked.reasons,
      };
      emitEvent(row.workspaceId, next.event, data, at);
      queueEmails(row, incidentId, next.event, schedule.name, checked.reasons, at);
    }
    db.update(monitors)
      .set({
        state: next.state,
        failures: next.failures,
        successes: next.successes,
        openIncidentId: next.event === "monitor.recovered" ? null : incidentId,
        updatedAt: at,
      })
      .where(eq(monitors.id, id))
      .run();
  });
  pruneMonitorHistory(
    resolveSettings(readSavedSettings(), process.env).values["monitors.retentionDays"] as number,
    at,
  );
  startMonitorEmailWorker();
}
export function pruneMonitorHistory(days: number, at = Date.now()) {
  const db = getDb();
  if (days > 0) {
    db.delete(monitorSamples)
      .where(lt(monitorSamples.at, at - days * 86400000))
      .run();
    db.delete(monitorIncidents)
      .where(
        and(
          isNotNull(monitorIncidents.resolvedAt),
          lt(monitorIncidents.resolvedAt, at - days * 86400000),
          notInArray(
            monitorIncidents.id,
            db
              .select({ id: monitorEmails.incidentId })
              .from(monitorEmails)
              .where(eq(monitorEmails.status, "pending")),
          ),
        ),
      )
      .run();
    db.delete(monitorEmails)
      .where(and(isNotNull(monitorEmails.finishedAt), lt(monitorEmails.finishedAt, at - days * 86400000)))
      .run();
  }
  for (const monitor of db.select({ id: monitors.id }).from(monitors).all()) {
    getSqlite()
      .prepare(
        "DELETE FROM monitor_samples WHERE id IN (SELECT id FROM monitor_samples WHERE monitor_id=? ORDER BY at DESC,id DESC LIMIT -1 OFFSET 10000)",
      )
      .run(monitor.id);
    getSqlite()
      .prepare(
        "DELETE FROM monitor_incidents WHERE id IN (SELECT id FROM monitor_incidents WHERE monitor_id=? AND resolved_at IS NOT NULL AND id NOT IN (SELECT incident_id FROM monitor_emails WHERE status='pending') ORDER BY started_at DESC LIMIT -1 OFFSET 500)",
      )
      .run(monitor.id);
  }
}

export function retryMonitorEmail(id: string, deliveryId: string) {
  requireMonitor(id, "write");
  const row = getDb()
    .select()
    .from(monitorEmails)
    .where(and(eq(monitorEmails.monitorId, id), eq(monitorEmails.id, deliveryId)))
    .get();
  if (!row) throw new HttpError(404, "Email delivery not found");
  if (row.status !== "failed") throw new HttpError(409, "Only failed emails can be retried");
  getDb()
    .update(monitorEmails)
    .set({
      status: "pending",
      attempts: 0,
      lockedUntil: null,
      nextAttemptAt: Date.now(),
      lastError: null,
      finishedAt: null,
    })
    .where(eq(monitorEmails.id, deliveryId))
    .run();
  startMonitorEmailWorker();
  return { ok: true };
}
