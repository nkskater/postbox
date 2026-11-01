/**
 * Usage ledger and quotas. Every counted amount is a row in `usage_events`; quotas are rows in
 * `usage_limits`. A reservation checks every applicable limit and records the amount in one immediate
 * transaction, so concurrent callers cannot jointly pass a hard limit, and an idempotency key makes a
 * retried reservation count once.
 *
 * Limits that apply to a reservation: the workspace's own limit for the metric (else the default for all
 * workspaces), and the acting identity's own limit. Soft limits raise one alert per period; hard limits
 * refuse with HTTP 429. With no limits configured nothing is ever refused.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  USAGE_METRICS,
  checkLimit,
  isLimitPeriod,
  isUsageMetric,
  periodEnd,
  periodStart,
  type LimitPeriod,
  type UsageMetric,
} from "@/core/usage";
import { audit } from "./audit";
import { currentCaller } from "./access-context";
import { getDb, getSqlite, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";

const { usageEvents, usageLimits, usageAlerts } = schema;
type LimitRow = typeof usageLimits.$inferSelect;
type Scope = "workspace" | "default" | "identity";

export function actingUserId(): string | null {
  const caller = currentCaller();
  return caller?.kind === "user" ? caller.user.id : null;
}

function applicableLimits(
  workspaceId: string,
  userId: string | null,
  metric: UsageMetric,
): { limit: LimitRow; scope: Scope }[] {
  const db = getDb();
  const out: { limit: LimitRow; scope: Scope }[] = [];
  const own = db
    .select()
    .from(usageLimits)
    .where(
      and(
        eq(usageLimits.workspaceId, workspaceId),
        isNull(usageLimits.userId),
        eq(usageLimits.metric, metric),
      ),
    )
    .get();
  const fallback =
    own ??
    db
      .select()
      .from(usageLimits)
      .where(and(isNull(usageLimits.workspaceId), isNull(usageLimits.userId), eq(usageLimits.metric, metric)))
      .get();
  if (fallback) out.push({ limit: fallback, scope: own ? "workspace" : "default" });
  if (userId) {
    const mine = db
      .select()
      .from(usageLimits)
      .where(
        and(eq(usageLimits.userId, userId), isNull(usageLimits.workspaceId), eq(usageLimits.metric, metric)),
      )
      .get();
    if (mine) out.push({ limit: mine, scope: "identity" });
  }
  return out;
}

const windowOf = (limit: LimitRow, at: number) => {
  const period: LimitPeriod = isLimitPeriod(limit.period) ? limit.period : "month";
  return { period, from: periodStart(period, at), to: periodEnd(period, at) };
};

function usedInWindow(
  metric: UsageMetric,
  from: number,
  to: number,
  by: { workspaceId?: string; actorId?: string },
): number {
  const row = getDb()
    .select({ n: sql<number>`coalesce(sum(${usageEvents.amount}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.metric, metric),
        gte(usageEvents.at, from),
        lt(usageEvents.at, to),
        by.workspaceId ? eq(usageEvents.workspaceId, by.workspaceId) : undefined,
        by.actorId ? eq(usageEvents.actorId, by.actorId) : undefined,
      ),
    )
    .get();
  return Number(row?.n ?? 0);
}

const usedFor = (limit: LimitRow, scope: Scope, workspaceId: string, at: number) => {
  const w = windowOf(limit, at);
  return usedInWindow(
    limit.metric as UsageMetric,
    w.from,
    w.to,
    scope === "identity" ? { actorId: limit.userId! } : { workspaceId },
  );
};

function describeScope(limit: LimitRow, scope: Scope) {
  const per = USAGE_METRICS[limit.metric as UsageMetric]?.stock ? "" : ` per ${limit.period}`;
  return `${USAGE_METRICS[limit.metric as UsageMetric]?.label ?? limit.metric} for ${
    scope === "identity" ? "this account" : "this workspace"
  }${per}`;
}

/** Record an alert once per limit, workspace and period. Returns true when it is new. */
function alertOnce(
  limit: LimitRow,
  scope: Scope,
  kind: "soft" | "hard",
  workspaceId: string,
  used: number,
  value: number,
  at: number,
): boolean {
  const w = windowOf(limit, at);
  const res = getDb()
    .insert(usageAlerts)
    .values({
      id: newId(),
      at,
      limitId: limit.id,
      workspaceId: scope === "identity" ? "" : workspaceId,
      userId: limit.userId,
      metric: limit.metric,
      kind,
      periodStart: w.from,
      used,
      limitValue: value,
    })
    .onConflictDoNothing()
    .run();
  if (res.changes > 0)
    audit({
      action: kind === "soft" ? "usage.soft_limit" : "usage.hard_limit",
      entityKind: "other",
      workspaceId: scope === "identity" ? null : workspaceId,
      result: kind === "hard" ? "denied" : "ok",
      entityName: describeScope(limit, scope),
      changes: [{ field: kind === "soft" ? "softLimit" : "hardLimit", before: value, after: used }],
      meta: { metric: limit.metric, userId: limit.userId },
    });
  return res.changes > 0;
}

export interface UsageInput {
  workspaceId: string;
  metric: UsageMetric;
  amount?: number;
  /** Count a retry of the same operation once: the second reservation with this key records nothing. */
  key?: string;
  /** Defaults to the current caller. */
  userId?: string | null;
  at?: number;
  /** Refuse when a hard limit would be passed. Without it the amount is only recorded. */
  enforce?: boolean;
}

export interface UsageResult {
  recorded: boolean;
  duplicate: boolean;
}

class QuotaBlock {
  constructor(public message: string) {}
}

/** Check applicable limits and record the amount atomically. Throws HttpError(429) past a hard limit. */
export function reserveUsage(input: UsageInput): UsageResult {
  const amount = input.amount ?? 1;
  const at = input.at ?? Date.now();
  const userId = input.userId === undefined ? actingUserId() : input.userId;
  const blocked = getDb().transaction(
    (tx): UsageResult | QuotaBlock => {
      if (input.key) {
        const seen = tx
          .select({ id: usageEvents.id })
          .from(usageEvents)
          .where(and(eq(usageEvents.workspaceId, input.workspaceId), eq(usageEvents.idemKey, input.key)))
          .get();
        if (seen) return { recorded: false, duplicate: true };
      }
      const limits = applicableLimits(input.workspaceId, userId, input.metric);
      const checks = limits.map(({ limit, scope }) => ({
        limit,
        scope,
        used: usedFor(limit, scope, input.workspaceId, at),
      }));
      if (input.enforce)
        for (const c of checks) {
          if (c.limit.hardLimit === null) continue;
          const r = checkLimit({ used: c.used, amount, soft: null, hard: c.limit.hardLimit });
          if (!r.allowed) {
            alertOnce(c.limit, c.scope, "hard", input.workspaceId, c.used, c.limit.hardLimit, at);
            return new QuotaBlock(
              `Quota reached: ${describeScope(c.limit, c.scope)} is limited to ${c.limit.hardLimit} ${
                USAGE_METRICS[input.metric].unit
              }. An administrator can raise it under Settings → Usage & quotas.`,
            );
          }
        }
      tx.insert(usageEvents)
        .values({
          id: newId(),
          at,
          workspaceId: input.workspaceId,
          actorId: userId,
          metric: input.metric,
          amount,
          idemKey: input.key ?? null,
        })
        .run();
      for (const c of checks) {
        if (c.limit.softLimit === null) continue;
        const r = checkLimit({ used: c.used, amount, soft: c.limit.softLimit, hard: null });
        if (r.softExceeded)
          alertOnce(c.limit, c.scope, "soft", input.workspaceId, c.used + amount, c.limit.softLimit, at);
      }
      return { recorded: true, duplicate: false };
    },
    { behavior: "immediate" },
  );
  if (blocked instanceof QuotaBlock) throw new HttpError(429, blocked.message);
  return blocked;
}

/** Refuse (429) when a hard limit is already reached, without recording anything. */
export function assertHeadroom(workspaceId: string, metric: UsageMetric, userId?: string | null): void {
  const at = Date.now();
  const uid = userId === undefined ? actingUserId() : userId;
  for (const { limit, scope } of applicableLimits(workspaceId, uid, metric)) {
    if (limit.hardLimit === null) continue;
    const used = usedFor(limit, scope, workspaceId, at);
    if (!checkLimit({ used, amount: 1, soft: null, hard: limit.hardLimit }).allowed) {
      alertOnce(limit, scope, "hard", workspaceId, used, limit.hardLimit, at);
      throw new HttpError(
        429,
        `Quota reached: ${describeScope(limit, scope)} is limited to ${limit.hardLimit} ${USAGE_METRICS[metric].unit}. An administrator can raise it under Settings → Usage & quotas.`,
      );
    }
  }
}

// ----------------------------------------------------------------------------------------------- storage

const STORAGE_SQL = [
  `SELECT COALESCE(SUM(LENGTH(CAST(v.snapshot AS BLOB))), 0) AS n FROM catalog_versions v JOIN catalog_entries e ON e.id = v.entry_id WHERE e.workspace_id = ?`,
  "SELECT COALESCE(SUM(LENGTH(CAST(snapshot AS BLOB))), 0) AS n FROM documentation_publications WHERE workspace_id = ?",
  "SELECT COALESCE(SUM(LENGTH(CAST(request AS BLOB)) + LENGTH(CAST(COALESCE(response, '') AS BLOB))), 0) AS n FROM history WHERE workspace_id = ?",
  `SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(rr.response_body, '') AS BLOB)) + LENGTH(CAST(COALESCE(rr.response_headers, '') AS BLOB)) + LENGTH(CAST(COALESCE(rr.execution_details, '') AS BLOB))), 0) AS n
   FROM run_results rr JOIN runs r ON r.id = rr.run_id WHERE r.workspace_id = ?`,
  `SELECT COALESCE(SUM(LENGTH(CAST(dv.data AS BLOB))), 0) AS n
   FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id WHERE d.workspace_id = ?`,
  `SELECT COALESCE(SUM(LENGTH(CAST(pv.source AS BLOB))), 0) AS n
   FROM script_package_versions pv JOIN script_packages p ON p.id = pv.package_id WHERE p.workspace_id = ?`,
];

/** Bytes retained for a workspace: history, run results, datasets and script packages. */
export function storageBytes(workspaceId: string): number {
  const sqlite = getSqlite();
  return STORAGE_SQL.reduce(
    (sum, query) => sum + Number((sqlite.prepare(query).get(workspaceId) as { n: number }).n),
    0,
  );
}

const storageCache = new Map<string, { at: number; bytes: number }>();
/** Refuse (429) while retained storage is over a hard limit. Measured at most every 30 seconds. */
export function assertStorage(workspaceId: string): void {
  const limits = applicableLimits(workspaceId, null, "storage_bytes").filter(
    (l) => l.limit.hardLimit !== null,
  );
  if (!limits.length) return;
  const now = Date.now();
  let cached = storageCache.get(workspaceId);
  if (!cached || now - cached.at > 30_000) {
    cached = { at: now, bytes: storageBytes(workspaceId) };
    storageCache.set(workspaceId, cached);
  }
  for (const { limit, scope } of limits)
    if (cached.bytes >= limit.hardLimit!) {
      alertOnce(limit, scope, "hard", workspaceId, cached.bytes, limit.hardLimit!, now);
      throw new HttpError(
        429,
        `Storage quota reached: this workspace keeps ${cached.bytes} bytes and is limited to ${limit.hardLimit}. Clear history or run results under Settings → History & data.`,
      );
    }
}

/** Soft storage alerts, checked when the dashboard is read. */
function storageAlerts(workspaceId: string, bytes: number) {
  const now = Date.now();
  for (const { limit, scope } of applicableLimits(workspaceId, null, "storage_bytes"))
    if (limit.softLimit !== null && bytes > limit.softLimit)
      alertOnce(limit, scope, "soft", workspaceId, bytes, limit.softLimit, now);
}

// ----------------------------------------------------------------------------------------------- reporting

export interface UsageLine {
  metric: UsageMetric;
  label: string;
  unit: string;
  used: number;
  softLimit: number | null;
  hardLimit: number | null;
  period: LimitPeriod | null;
}

export function workspaceUsage(workspaceId: string, from: number, to: number): UsageLine[] {
  const lines: UsageLine[] = [];
  for (const [metric, info] of Object.entries(USAGE_METRICS) as [
    UsageMetric,
    (typeof USAGE_METRICS)[UsageMetric],
  ][]) {
    const used = info.stock ? storageBytes(workspaceId) : usedInWindow(metric, from, to, { workspaceId });
    if (info.stock) storageAlerts(workspaceId, used);
    const limit = applicableLimits(workspaceId, null, metric).find((l) => l.scope !== "identity")?.limit;
    lines.push({
      metric,
      label: info.label,
      unit: info.unit,
      used,
      softLimit: limit?.softLimit ?? null,
      hardLimit: limit?.hardLimit ?? null,
      period: limit && !info.stock && isLimitPeriod(limit.period) ? limit.period : null,
    });
  }
  return lines;
}

export interface WorkspaceUsageRow {
  workspaceId: string;
  workspaceName: string;
  deleted: boolean;
  lines: UsageLine[];
}

/** Usage of every workspace (and of deleted ones that still have recorded usage) over a window. */
export function allWorkspaceUsage(from: number, to: number): WorkspaceUsageRow[] {
  const db = getDb();
  const live = db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .all();
  const liveIds = new Set(live.map((w) => w.id));
  const gone = db
    .selectDistinct({ id: usageEvents.workspaceId })
    .from(usageEvents)
    .where(and(gte(usageEvents.at, from), lt(usageEvents.at, to)))
    .all()
    .filter((r) => !liveIds.has(r.id));
  return [
    ...live.map((w) => ({ workspaceId: w.id, workspaceName: w.name, deleted: false })),
    ...gone.map((w) => ({ workspaceId: w.id, workspaceName: "(deleted workspace)", deleted: true })),
  ].map((w) => ({
    ...w,
    lines: workspaceUsage(w.workspaceId, from, to).filter(
      (l) => !(w.deleted && l.metric === "storage_bytes"),
    ),
  }));
}

export function listAlerts(opts: { workspaceId?: string; limit?: number } = {}) {
  return getDb()
    .select()
    .from(usageAlerts)
    .where(opts.workspaceId ? inArray(usageAlerts.workspaceId, [opts.workspaceId, ""]) : undefined)
    .orderBy(desc(usageAlerts.at))
    .limit(Math.min(opts.limit ?? 50, 500))
    .all();
}

// ----------------------------------------------------------------------------------------------- limits

export function listLimits() {
  return getDb().select().from(usageLimits).orderBy(usageLimits.createdAt).all();
}

export interface LimitInput {
  workspaceId?: string | null;
  userId?: string | null;
  metric: string;
  period?: string;
  softLimit?: number | null;
  hardLimit?: number | null;
}

/** Create or replace the limit for one scope (default, workspace or identity) and metric. */
export function setLimit(input: LimitInput) {
  if (!isUsageMetric(input.metric)) throw new HttpError(400, "Unknown usage metric");
  const period = input.period ?? "month";
  if (!isLimitPeriod(period)) throw new HttpError(400, 'period must be "day" or "month"');
  if (input.workspaceId && input.userId)
    throw new HttpError(400, "A limit applies to a workspace or an identity, not both");
  const soft = input.softLimit ?? null;
  const hard = input.hardLimit ?? null;
  for (const v of [soft, hard])
    if (v !== null && (!Number.isInteger(v) || v < 0))
      throw new HttpError(400, "Limits must be whole numbers, 0 or more");
  if (soft !== null && hard !== null && soft > hard)
    throw new HttpError(400, "The soft limit cannot be above the hard limit");
  const db = getDb();
  if (
    input.workspaceId &&
    !db.select().from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)).get()
  )
    throw new HttpError(404, "Workspace not found");
  if (input.userId && !db.select().from(schema.users).where(eq(schema.users.id, input.userId)).get())
    throw new HttpError(404, "User not found");
  const now = Date.now();
  const existing = db
    .select()
    .from(usageLimits)
    .where(
      and(
        input.workspaceId ? eq(usageLimits.workspaceId, input.workspaceId) : isNull(usageLimits.workspaceId),
        input.userId ? eq(usageLimits.userId, input.userId) : isNull(usageLimits.userId),
        eq(usageLimits.metric, input.metric),
      ),
    )
    .get();
  const row = existing
    ? { ...existing, period, softLimit: soft, hardLimit: hard, updatedAt: now }
    : {
        id: newId(),
        workspaceId: input.workspaceId ?? null,
        userId: input.userId ?? null,
        metric: input.metric,
        period,
        softLimit: soft,
        hardLimit: hard,
        createdAt: now,
        updatedAt: now,
      };
  if (existing) db.update(usageLimits).set(row).where(eq(usageLimits.id, row.id)).run();
  else db.insert(usageLimits).values(row).run();
  audit({
    action: "usage.limit.set",
    entityKind: "other",
    entityId: row.id,
    entityName: `${row.metric} limit`,
    workspaceId: row.workspaceId,
    changes: [
      { field: "softLimit", before: existing?.softLimit ?? null, after: soft },
      { field: "hardLimit", before: existing?.hardLimit ?? null, after: hard },
      { field: "period", before: existing?.period ?? null, after: period },
    ].filter((c) => c.before !== c.after),
    meta: { userId: row.userId },
  });
  return row;
}

export function deleteLimit(id: string): boolean {
  const row = getDb().select().from(usageLimits).where(eq(usageLimits.id, id)).get();
  if (!row) return false;
  getDb().delete(usageLimits).where(eq(usageLimits.id, id)).run();
  audit({
    action: "usage.limit.delete",
    entityKind: "other",
    entityId: id,
    entityName: `${row.metric} limit`,
    workspaceId: row.workspaceId,
    changes: [
      { field: "softLimit", before: row.softLimit, after: null },
      { field: "hardLimit", before: row.hardLimit, after: null },
    ],
  });
  return true;
}

// ------------------------------------------------------------------------------------------ reconciliation

export interface ReconcileReport {
  runsChecked: number;
  missing: number;
  mismatched: number;
  repaired: number;
}

/**
 * Compare the ledger with the run history and optionally repair it. Every run should have a `runs`,
 * `run_ms` and `run_requests` entry keyed by its id. Repair adds missing entries and corrects amounts,
 * and is safe to repeat.
 */
export function reconcileRuns(opts: {
  from: number;
  to: number;
  workspaceId?: string;
  repair?: boolean;
}): ReconcileReport {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.runs)
    .where(
      and(
        gte(schema.runs.startedAt, opts.from),
        lt(schema.runs.startedAt, opts.to),
        opts.workspaceId ? eq(schema.runs.workspaceId, opts.workspaceId) : undefined,
      ),
    )
    .all();
  const report: ReconcileReport = { runsChecked: rows.length, missing: 0, mismatched: 0, repaired: 0 };
  db.transaction(
    (tx) => {
      for (const run of rows) {
        const finished = run.finishedAt !== null;
        const expected: [UsageMetric, string, number][] = [["runs", `run:${run.id}`, 1]];
        if (finished && (run.durationMs ?? 0) > 0)
          expected.push(["run_ms", `run_ms:${run.id}`, run.durationMs ?? 0]);
        if (finished && (run.totalRequests ?? 0) > 0)
          expected.push(["requests", `run_requests:${run.id}`, run.totalRequests ?? 0]);
        for (const [metric, key, amount] of expected) {
          const have = tx
            .select()
            .from(usageEvents)
            .where(and(eq(usageEvents.workspaceId, run.workspaceId), eq(usageEvents.idemKey, key)))
            .get();
          if (!have) {
            report.missing++;
            if (opts.repair) {
              tx.insert(usageEvents)
                .values({
                  id: newId(),
                  at: run.startedAt ?? Date.now(),
                  workspaceId: run.workspaceId,
                  actorId: run.createdBy,
                  metric,
                  amount,
                  idemKey: key,
                })
                .run();
              report.repaired++;
            }
          } else if (have.amount !== amount) {
            report.mismatched++;
            if (opts.repair) {
              tx.update(usageEvents).set({ amount }).where(eq(usageEvents.id, have.id)).run();
              report.repaired++;
            }
          }
        }
      }
    },
    { behavior: "immediate" },
  );
  return report;
}

/** Remove ledger rows older than `days` (0 keeps everything). Alerts older than that go too. */
export function pruneUsage(days: number, at = Date.now()): number {
  if (!days) return 0;
  const cutoff = at - days * 86_400_000;
  getDb().delete(usageAlerts).where(lt(usageAlerts.at, cutoff)).run();
  return getDb().delete(usageEvents).where(lt(usageEvents.at, cutoff)).run().changes;
}
