import { createHash } from "node:crypto";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  scorecardConfig,
  SCORECARD_LIMITS,
  type Fact,
  type Facts,
  type ScorecardConfig,
} from "@/core/scorecards/model";
import {
  compareEvaluations,
  evaluateScorecard,
  summarizeEvaluations,
  type Evaluation,
} from "@/core/scorecards/evaluate";
import { stableJson } from "@/core/specifications/merge";
import { getDb, schema } from "./db";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError, isHttpError } from "./errors";
import { newId } from "./defaults";
import { assertStorage } from "./usage";
import { getCatalogService } from "./catalog";
import { requireMonitor } from "./monitors";
import { requireSpecification } from "./specifications";
import { getSpecificationGovernance } from "./governance";
import { requireEnvironmentIn } from "./repo";
const {
  qualityScorecards: cards,
  qualityScorecardVersions: versions,
  qualityBindings: bindings,
  qualityReports: reports,
} = schema;
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export const createScorecardInput = z
  .object({ workspaceId: z.string().min(1), config: scorecardConfig, label: z.string().max(200).default("") })
  .strict();
export const saveScorecardInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: scorecardConfig,
    label: z.string().max(200).default(""),
  })
  .strict();
export const qualityFilter = z
  .object({
    tag: z.string().max(100).optional(),
    owner: z.string().max(100).optional(),
    environmentId: z.string().max(200).optional(),
  })
  .strict();
export const qualityCheckInput = z
  .object({ version: z.number().int().positive().optional(), filters: qualityFilter.default({}) })
  .strict();
export const qualityBindingInput = z
  .object({
    entryId: z.string().min(1),
    environmentId: z.string().default(""),
    specificationId: z.string().nullable().default(null),
    monitorId: z.string().nullable().default(null),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
export const qualityCompareInput = z
  .object({ beforeId: z.string().min(1), afterId: z.string().min(1), filters: qualityFilter.default({}) })
  .strict();
export function requireScorecard(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(cards).where(eq(cards.id, id)).get();
  if (!row) throw new HttpError(404, "Scorecard not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
export function listScorecards(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(cards)
    .where(eq(cards.workspaceId, workspaceId))
    .orderBy(desc(cards.updatedAt), cards.id)
    .all();
}
export function getScorecard(id: string, version?: number) {
  const row = requireScorecard(id);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
    throw new HttpError(400, "Invalid scorecard version");
  const selected = getDb()
    .select()
    .from(versions)
    .where(and(eq(versions.scorecardId, id), eq(versions.version, version ?? row.revision)))
    .get();
  if (!selected) throw new HttpError(404, "Scorecard version not found");
  return {
    ...row,
    version: selected.version,
    config: selected.config,
    versions: getDb()
      .select({ version: versions.version, label: versions.label, createdAt: versions.createdAt })
      .from(versions)
      .where(eq(versions.scorecardId, id))
      .orderBy(desc(versions.version))
      .all(),
  };
}
export function createScorecard(raw: z.input<typeof createScorecardInput>) {
  const input = createScorecardInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  if (listScorecards(input.workspaceId).length >= SCORECARD_LIMITS.cards)
    throw new HttpError(429, "At most 50 scorecards per workspace");
  assertStorage(input.workspaceId);
  const id = newId(),
    now = Date.now();
  getDb().transaction((tx) => {
    tx.insert(cards)
      .values({ id, workspaceId: input.workspaceId, name: input.config.name, createdAt: now, updatedAt: now })
      .run();
    tx.insert(versions)
      .values({ scorecardId: id, version: 1, config: input.config, label: input.label, createdAt: now })
      .run();
  });
  return getScorecard(id);
}
export function saveScorecard(id: string, raw: z.input<typeof saveScorecardInput>) {
  const row = requireScorecard(id, "write"),
    input = saveScorecardInput.parse(raw);
  if (row.revision !== input.expectedRevision)
    throw new HttpError(409, "Scorecard changed; reload before saving");
  if (row.revision >= SCORECARD_LIMITS.versions) throw new HttpError(429, "At most 100 scorecard versions");
  assertStorage(row.workspaceId);
  const revision = row.revision + 1;
  getDb().transaction((tx) => {
    const changed = tx
      .update(cards)
      .set({ name: input.config.name, revision, updatedAt: Date.now() })
      .where(and(eq(cards.id, id), eq(cards.revision, input.expectedRevision)))
      .run();
    if (!changed.changes) throw new HttpError(409, "Scorecard changed; reload before saving");
    tx.insert(versions)
      .values({
        scorecardId: id,
        version: revision,
        config: input.config,
        label: input.label,
        createdAt: Date.now(),
      })
      .run();
  });
  return getScorecard(id);
}
export function deleteScorecard(id: string) {
  requireScorecard(id, "write");
  getDb().delete(cards).where(eq(cards.id, id)).run();
  return { ok: true };
}
function visibleEntry(id: string, workspaceId: string) {
  const row = getCatalogService(id);
  if (row.workspaceId !== workspaceId) throw new HttpError(404, "Catalog service not found");
  return row;
}

function canSeeEntry(id: string, workspaceId: string) {
  try {
    visibleEntry(id, workspaceId);
    return true;
  } catch (e) {
    if (isHttpError(e) && e.status === 404) return false;
    throw e;
  }
}
export function scorecardSources(id: string) {
  const card = requireScorecard(id),
    workspaceId = card.workspaceId;
  const entries = getDb()
    .select()
    .from(schema.catalogEntries)
    .where(and(eq(schema.catalogEntries.workspaceId, workspaceId), eq(schema.catalogEntries.enabled, true)))
    .all()
    .filter((e) => canSeeEntry(e.id, workspaceId));
  return {
    entries: entries.map((e) => ({
      id: e.id,
      title: e.title,
      folderId: e.folderId,
      tags: e.tags,
      owners: e.owners,
    })),
    environments: getDb()
      .select({ id: schema.environments.id, name: schema.environments.name })
      .from(schema.environments)
      .where(eq(schema.environments.workspaceId, workspaceId))
      .all(),
    specifications: getDb()
      .select({ id: schema.specifications.id, name: schema.specifications.name })
      .from(schema.specifications)
      .where(eq(schema.specifications.workspaceId, workspaceId))
      .all(),
    monitors: getDb()
      .select({
        id: schema.monitors.id,
        name: schema.schedules.name,
        folderId: schema.schedules.folderId,
        environmentId: schema.schedules.environmentId,
      })
      .from(schema.monitors)
      .innerJoin(schema.schedules, eq(schema.monitors.scheduleId, schema.schedules.id))
      .where(eq(schema.monitors.workspaceId, workspaceId))
      .all(),
    bindings: getDb()
      .select()
      .from(bindings)
      .where(eq(bindings.scorecardId, id))
      .all()
      .filter((b) => entries.some((e) => e.id === b.entryId)),
  };
}
export function bindQualityService(id: string, raw: z.input<typeof qualityBindingInput>) {
  const card = requireScorecard(id, "write"),
    input = qualityBindingInput.parse(raw),
    entry = visibleEntry(input.entryId, card.workspaceId);
  if (input.environmentId) requireEnvironmentIn(card.workspaceId, input.environmentId);
  if (input.specificationId && requireSpecification(input.specificationId).workspaceId !== card.workspaceId)
    throw new HttpError(404, "Specification not found");
  if (input.monitorId) {
    const m = requireMonitor(input.monitorId),
      schedule = getDb().select().from(schema.schedules).where(eq(schema.schedules.id, m.scheduleId)).get();
    if (
      m.workspaceId !== card.workspaceId ||
      !schedule ||
      schedule.folderId !== entry.folderId ||
      (schedule.environmentId ?? "") !== input.environmentId
    )
      throw new HttpError(400, "Monitor must match this service collection and environment");
  }
  const existing = getDb()
    .select()
    .from(bindings)
    .where(
      and(
        eq(bindings.scorecardId, id),
        eq(bindings.entryId, input.entryId),
        eq(bindings.environmentId, input.environmentId),
      ),
    )
    .get();
  if ((existing?.revision ?? 0) !== input.expectedRevision)
    throw new HttpError(409, "Service assignment changed; reload before saving");
  if (
    !existing &&
    getDb().select().from(bindings).where(eq(bindings.scorecardId, id)).all().length >=
      SCORECARD_LIMITS.bindings
  )
    throw new HttpError(429, "At most 200 service/environment assignments per scorecard");
  assertStorage(card.workspaceId);
  const now = Date.now();
  const row = {
    id: existing?.id ?? newId(),
    scorecardId: id,
    workspaceId: card.workspaceId,
    entryId: input.entryId,
    environmentId: input.environmentId,
    specificationId: input.specificationId,
    monitorId: input.monitorId,
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const changed = getDb()
    .insert(bindings)
    .values(row)
    .onConflictDoUpdate({
      target: [bindings.scorecardId, bindings.entryId, bindings.environmentId],
      set: row,
      setWhere: eq(bindings.revision, input.expectedRevision),
    })
    .run();
  if (!changed.changes) throw new HttpError(409, "Service assignment changed; reload before saving");
  return row;
}
export function removeQualityService(id: string, bindingId: string) {
  const card = requireScorecard(id, "write"),
    row = getDb()
      .select()
      .from(bindings)
      .where(and(eq(bindings.scorecardId, id), eq(bindings.id, bindingId)))
      .get();
  if (!row) throw new HttpError(404, "Assignment not found");
  visibleEntry(row.entryId, card.workspaceId);
  getDb().delete(bindings).where(eq(bindings.id, bindingId)).run();
  return { ok: true };
}
interface QualityService {
  bindingId: string;
  bindingRevision: number;
  entryId: string;
  title: string;
  tags: string[];
  owners: string[];
  environmentId: string;
  environmentName: string;
  catalogVersion: number;
  evaluation: Evaluation;
  sourceHash: string;
}
export interface QualityReport {
  formatVersion: 1;
  scorecardId: string;
  version: number;
  config: ScorecardConfig;
  policyHash: string;
  at: number;
  filters: z.infer<typeof qualityFilter>;
  viewFilters?: z.infer<typeof qualityFilter>;
  services: QualityService[];
}
const unavailable = (reason: string): Fact => ({
  value: null,
  observedAt: null,
  state: "unavailable",
  reason,
  source: null,
});
function sourceFacts(
  binding: typeof bindings.$inferSelect,
  entry: typeof schema.catalogEntries.$inferSelect,
  at: number,
): Facts {
  const catalogVersion = getDb()
    .select()
    .from(schema.catalogVersions)
    .where(
      and(
        eq(schema.catalogVersions.entryId, entry.id),
        eq(schema.catalogVersions.version, entry.latestVersion),
      ),
    )
    .get();
  const catalog = (value: number): Fact => ({
    value,
    observedAt: entry.updatedAt,
    state: "available",
    reason: "Current catalog metadata",
    source: { kind: "catalog", id: entry.id, version: String(entry.revision) },
  });
  const facts: Facts = {
    description: catalog(entry.description.trim() ? 1 : 0),
    ownership: catalog(entry.owners.length ? 1 : 0),
    publishedAgeHours: catalogVersion
      ? {
          ...catalog(Math.max(0, (at - catalogVersion.createdAt) / 3600000)),
          observedAt: catalogVersion.createdAt,
        }
      : unavailable("No published catalog version"),
  };
  const runtimeKeys = ["availability", "assertions", "latency", "tests", "scriptErrors"] as const;
  for (const key of runtimeKeys) facts[key] = unavailable("No monitor is assigned");
  if (binding.monitorId) {
    const monitor = requireMonitor(binding.monitorId),
      schedule = getDb()
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.id, monitor.scheduleId))
        .get();
    const matches =
      monitor.workspaceId === binding.workspaceId &&
      schedule?.folderId === entry.folderId &&
      (schedule?.environmentId ?? "") === binding.environmentId;
    const sample = matches
      ? getDb()
          .select()
          .from(schema.monitorSamples)
          .where(eq(schema.monitorSamples.monitorId, monitor.id))
          .orderBy(desc(schema.monitorSamples.at), desc(schema.monitorSamples.id))
          .get()
      : null;
    if (!matches || !sample || sample.outcome === "skipped")
      for (const key of runtimeKeys)
        facts[key] = unavailable(
          !matches
            ? "Monitor configuration no longer matches this service/environment"
            : "No completed monitor sample is available",
        );
    else {
      const m = sample.metrics,
        values = {
          availability: m.requests ? m.availability : null,
          assertions: m.assertions,
          latency: m.p95Ms,
          tests: m.tests,
          scriptErrors: m.scriptErrors,
        };
      for (const key of runtimeKeys)
        facts[key] = {
          value: values[key],
          observedAt: sample.at,
          state: values[key] === null ? "unavailable" : "available",
          reason:
            values[key] === null
              ? "The monitor sample has no observations for this metric"
              : "Latest retained monitor sample",
          source: { kind: "monitor", id: monitor.id, version: `${monitor.revision}:${sample.id}` },
        };
    }
  }
  const governanceKeys = ["governanceErrors", "governanceWarnings", "governancePassRate"] as const;
  for (const key of governanceKeys) facts[key] = unavailable("No specification is assigned");
  if (binding.specificationId) {
    const spec = requireSpecification(binding.specificationId);
    if (spec.workspaceId !== binding.workspaceId) throw new HttpError(404, "Specification not found");
    const state = getSpecificationGovernance(spec.id),
      saved = state.latest;
    if (!saved)
      for (const key of governanceKeys)
        facts[key] = unavailable("No retained governance report is available");
    else {
      const r = saved.report,
        values = {
          governanceErrors: r.summary.errors,
          governanceWarnings: r.summary.warnings,
          governancePassRate: r.summary.evaluated
            ? (100 * Math.max(0, r.summary.evaluated - r.diagnostics.length)) / r.summary.evaluated
            : null,
        };
      for (const key of governanceKeys)
        facts[key] = {
          value: values[key],
          observedAt: saved.createdAt,
          state:
            !r.complete || !r.summary.evaluated
              ? "unavailable"
              : state.stale
                ? "stale"
                : values[key] === null
                  ? "unavailable"
                  : "available",
          reason: !r.complete
            ? "Governance evaluation is incomplete"
            : !r.summary.evaluated
              ? "No governance targets were evaluated"
              : state.stale
                ? "Governance report no longer matches the saved specification/policy"
                : values[key] === null
                  ? "No governance targets were evaluated"
                  : "Latest retained governance report",
          source: { kind: "governance", id: spec.id, version: `${spec.revision}:${saved.id}` },
        };
    }
  }
  if (
    binding.environmentId &&
    !getDb()
      .select()
      .from(schema.environments)
      .where(
        and(
          eq(schema.environments.id, binding.environmentId),
          eq(schema.environments.workspaceId, binding.workspaceId),
        ),
      )
      .get()
  )
    for (const key of [...runtimeKeys, ...governanceKeys])
      facts[key] = unavailable("Assigned environment was deleted");
  return facts;
}
function matches(
  service: Pick<QualityService, "tags" | "owners" | "environmentId">,
  filter: z.infer<typeof qualityFilter>,
) {
  return (
    (!filter.tag || service.tags.includes(filter.tag)) &&
    (!filter.owner || service.owners.includes(filter.owner)) &&
    (filter.environmentId === undefined || service.environmentId === filter.environmentId)
  );
}
export function previewScorecard(id: string, raw: z.input<typeof qualityCheckInput> = {}) {
  const input = qualityCheckInput.parse(raw),
    card = getScorecard(id, input.version),
    at = Date.now();
  const services: QualityService[] = [];
  for (const binding of getDb()
    .select()
    .from(bindings)
    .where(eq(bindings.scorecardId, id))
    .orderBy(bindings.id)
    .all()) {
    if (!canSeeEntry(binding.entryId, card.workspaceId)) continue;
    const entry = visibleEntry(binding.entryId, card.workspaceId);
    if (!matches({ ...entry, environmentId: binding.environmentId }, input.filters)) continue;
    const facts = sourceFacts(binding, entry, at),
      env = binding.environmentId
        ? getDb()
            .select()
            .from(schema.environments)
            .where(eq(schema.environments.id, binding.environmentId))
            .get()
        : null;
    services.push({
      bindingId: binding.id,
      bindingRevision: binding.revision,
      entryId: entry.id,
      title: entry.title,
      tags: entry.tags,
      owners: entry.owners,
      environmentId: binding.environmentId,
      environmentName: env?.name ?? (binding.environmentId ? "Deleted environment" : "No environment"),
      catalogVersion: entry.latestVersion,
      evaluation: evaluateScorecard(card.config, facts, at),
      sourceHash: digest(facts),
    });
  }
  const report: QualityReport = {
    formatVersion: 1,
    scorecardId: id,
    version: card.version,
    config: card.config,
    policyHash: digest(card.config),
    at,
    filters: input.filters,
    services,
  };
  return summarize(report);
}
function summarize(report: QualityReport) {
  return {
    ...report,
    summary: summarizeEvaluations(
      report.services.map((s) => s.evaluation),
      report.config,
    ),
  };
}

export function saveQualityReport(id: string, raw: z.input<typeof qualityCheckInput> = {}) {
  const card = requireScorecard(id, "write"),
    report = previewScorecard(id, raw);
  assertStorage(card.workspaceId);
  const reportId = newId(),
    createdAt = Math.max(
      Date.now(),
      (getDb()
        .select()
        .from(reports)
        .where(eq(reports.scorecardId, id))
        .orderBy(desc(reports.createdAt))
        .get()?.createdAt ?? 0) + 1,
    );
  getDb().transaction((tx) => {
    tx.insert(reports)
      .values({ id: reportId, scorecardId: id, workspaceId: card.workspaceId, report, createdAt })
      .run();
    const retained = tx
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.scorecardId, id))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(SCORECARD_LIMITS.reports)
      .all()
      .map((r) => r.id);
    tx.delete(reports)
      .where(and(eq(reports.scorecardId, id), notInArray(reports.id, retained)))
      .run();
  });
  return getQualityReport(id, reportId);
}
export function getQualityReport(id: string, reportId: string, raw: z.input<typeof qualityFilter> = {}) {
  const card = requireScorecard(id),
    filters = qualityFilter.parse(raw),
    row = getDb()
      .select()
      .from(reports)
      .where(and(eq(reports.scorecardId, id), eq(reports.id, reportId)))
      .get();
  if (!row) throw new HttpError(404, "Scorecard report not found");
  return {
    id: row.id,
    createdAt: row.createdAt,
    report: summarize({
      ...row.report,
      viewFilters: filters,
      services: row.report.services.filter(
        (s) => canSeeEntry(s.entryId, card.workspaceId) && matches(s, filters),
      ),
    }),
  };
}
export function listQualityReports(id: string, raw: z.input<typeof qualityFilter> = {}) {
  requireScorecard(id);
  return getDb()
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.scorecardId, id))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .all()
    .map(({ id: reportId }) => {
      const saved = getQualityReport(id, reportId, raw);
      return {
        id: saved.id,
        createdAt: saved.createdAt,
        version: saved.report.version,
        summary: saved.report.summary,
        filters: saved.report.filters,
      };
    });
}
export function compareQualityReports(id: string, raw: z.input<typeof qualityCompareInput>) {
  const input = qualityCompareInput.parse(raw),
    before = getQualityReport(id, input.beforeId, input.filters),
    after = getQualityReport(id, input.afterId, input.filters);
  return {
    beforeId: before.id,
    afterId: after.id,
    policyChanged: before.report.policyHash !== after.report.policyHash,
    services: after.report.services.map((service) => {
      const old = before.report.services.find(
        (s) => s.entryId === service.entryId && s.environmentId === service.environmentId,
      );
      return {
        entryId: service.entryId,
        environmentId: service.environmentId,
        title: service.title,
        environmentName: service.environmentName,
        comparison: old ? compareEvaluations(old.evaluation, service.evaluation) : null,
      };
    }),
    removed: before.report.services
      .filter(
        (service) =>
          !after.report.services.some(
            (s) => s.entryId === service.entryId && s.environmentId === service.environmentId,
          ),
      )
      .map((s) => ({
        entryId: s.entryId,
        environmentId: s.environmentId,
        title: s.title,
        environmentName: s.environmentName,
      })),
  };
}
