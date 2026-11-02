import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  governanceConfig,
  governanceOverrides,
  governanceExclusion,
  effectiveGovernanceConfig,
  GOVERNANCE_LIMITS,
} from "@/core/governance/model";
import { lintGovernance } from "@/core/governance/lint";
import { specificationSource } from "@/core/specifications/model";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { assertStorage } from "./usage";
import { getSpecification, requireSpecification } from "./specifications";
const {
  governanceRuleSets: sets,
  governanceRuleVersions: versions,
  governanceBindings: bindings,
  governanceReports: reports,
} = schema;
export const createRuleSetInput = z
  .object({
    workspaceId: z.string().min(1),
    config: governanceConfig,
    label: z.string().max(200).default(""),
  })
  .strict();
export const saveRuleSetInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: governanceConfig,
    label: z.string().max(200).default(""),
  })
  .strict();
export const bindGovernanceInput = z
  .object({
    ruleSetId: z.string().min(1),
    ruleVersion: z.number().int().positive().nullable().default(null),
    overrides: governanceOverrides.default({}),
    exclusions: z.array(governanceExclusion).max(GOVERNANCE_LIMITS.exclusions).default([]),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
export const lintDraftInput = z
  .object({ workspaceId: z.string().min(1), source: specificationSource, config: governanceConfig })
  .strict();
export const checkGovernanceInput = z.object({ version: z.number().int().positive().optional() }).strict();
export function requireRuleSet(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(sets).where(eq(sets.id, id)).get();
  if (!row) throw new HttpError(404, "Rule set not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
export function listRuleSets(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(sets)
    .where(eq(sets.workspaceId, workspaceId))
    .orderBy(desc(sets.updatedAt))
    .all();
}
export function getRuleSet(id: string, version?: number) {
  const row = requireRuleSet(id);
  if (version !== undefined && (!Number.isInteger(version) || version < 1))
    throw new HttpError(400, "Invalid rule version");
  const stored = getDb()
    .select()
    .from(versions)
    .where(and(eq(versions.ruleSetId, id), eq(versions.version, version ?? row.revision)))
    .get();
  if (!stored) throw new HttpError(404, "Rule version not found");
  return {
    ...row,
    ...stored,
    versions: getDb()
      .select({ version: versions.version, label: versions.label, createdAt: versions.createdAt })
      .from(versions)
      .where(eq(versions.ruleSetId, id))
      .orderBy(desc(versions.version))
      .all(),
  };
}
export function createRuleSet(raw: z.input<typeof createRuleSetInput>) {
  const input = createRuleSetInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  if (listRuleSets(input.workspaceId).length >= GOVERNANCE_LIMITS.sets)
    throw new HttpError(429, "At most 50 governance rule sets per workspace");
  assertStorage(input.workspaceId);
  const id = newId(),
    now = Date.now();
  getDb().transaction(() => {
    getDb()
      .insert(sets)
      .values({ id, workspaceId: input.workspaceId, name: input.config.name, createdAt: now, updatedAt: now })
      .run();
    getDb()
      .insert(versions)
      .values({ ruleSetId: id, version: 1, config: input.config, label: input.label, createdAt: now })
      .run();
  });
  return getRuleSet(id);
}
export function saveRuleSet(id: string, raw: z.input<typeof saveRuleSetInput>) {
  const current = requireRuleSet(id, "write"),
    input = saveRuleSetInput.parse(raw);
  if (current.revision !== input.expectedRevision)
    throw new HttpError(409, "Rule set changed; reload before saving");
  if (current.revision >= GOVERNANCE_LIMITS.versions)
    throw new HttpError(429, "At most 100 versions per rule set");
  assertStorage(current.workspaceId);
  getDb().transaction(() => {
    const revision = current.revision + 1;
    const changed = getDb()
      .update(sets)
      .set({ revision, name: input.config.name, updatedAt: Date.now() })
      .where(and(eq(sets.id, id), eq(sets.revision, input.expectedRevision)))
      .run();
    if (!changed.changes) throw new HttpError(409, "Rule set changed; reload before saving");
    getDb()
      .insert(versions)
      .values({
        ruleSetId: id,
        version: revision,
        config: input.config,
        label: input.label,
        createdAt: Date.now(),
      })
      .run();
  });
  return getRuleSet(id);
}
export function deleteRuleSet(id: string) {
  requireRuleSet(id, "write");
  getDb().delete(sets).where(eq(sets.id, id)).run();
  return { ok: true };
}
function effective(specificationId: string) {
  const spec = requireSpecification(specificationId),
    binding = getDb().select().from(bindings).where(eq(bindings.specificationId, specificationId)).get();
  if (!binding) throw new HttpError(400, "Attach a governance rule set first");
  const rule = getRuleSet(binding.ruleSetId, binding.ruleVersion ?? undefined);
  if (rule.workspaceId !== spec.workspaceId) throw new HttpError(404, "Rule set not found");
  return {
    binding,
    rule,
    config: effectiveGovernanceConfig(rule.config, binding.overrides, binding.exclusions),
  };
}
export function getSpecificationGovernance(specificationId: string) {
  const spec = requireSpecification(specificationId),
    binding = getDb().select().from(bindings).where(eq(bindings.specificationId, specificationId)).get();
  if (!binding) return { binding: null, rule: null, config: null, latest: null, stale: true };
  const rule = getRuleSet(binding.ruleSetId, binding.ruleVersion ?? undefined);
  if (rule.workspaceId !== spec.workspaceId) throw new HttpError(404, "Rule set not found");
  let config: ReturnType<typeof effectiveGovernanceConfig> | null = null,
    configurationError = "";
  try {
    config = effectiveGovernanceConfig(rule.config, binding.overrides, binding.exclusions);
  } catch {
    configurationError = "Policy rules changed; revise overrides/exclusions or pin a compatible version.";
  }
  const latest =
    getDb()
      .select()
      .from(reports)
      .where(eq(reports.specificationId, specificationId))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .get() ?? null;
  return {
    binding,
    rule,
    config,
    configurationError,
    latest,
    stale:
      !!configurationError ||
      !latest ||
      latest.specVersion !== spec.revision ||
      latest.ruleSetId !== rule.id ||
      latest.ruleVersion !== rule.version ||
      latest.bindingRevision !== binding.revision,
  };
}
export function bindGovernance(specificationId: string, raw: z.input<typeof bindGovernanceInput>) {
  const spec = requireSpecification(specificationId, "write"),
    input = bindGovernanceInput.parse(raw),
    rule = getRuleSet(input.ruleSetId, input.ruleVersion ?? undefined);
  if (rule.workspaceId !== spec.workspaceId) throw new HttpError(404, "Rule set not found");
  effectiveGovernanceConfig(rule.config, input.overrides, input.exclusions);
  const old = getDb().select().from(bindings).where(eq(bindings.specificationId, specificationId)).get();
  if ((old?.revision ?? 0) !== input.expectedRevision)
    throw new HttpError(409, "Governance binding changed; reload before saving");
  const row = {
    specificationId,
    workspaceId: spec.workspaceId,
    ruleSetId: input.ruleSetId,
    ruleVersion: input.ruleVersion,
    overrides: input.overrides,
    exclusions: input.exclusions,
    revision: (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  const changed = getDb()
    .insert(bindings)
    .values(row)
    .onConflictDoUpdate({
      target: bindings.specificationId,
      set: row,
      setWhere: eq(bindings.revision, input.expectedRevision),
    })
    .run();
  if (!changed.changes) throw new HttpError(409, "Governance binding changed; reload before saving");
  return getSpecificationGovernance(specificationId);
}
export function unbindGovernance(specificationId: string) {
  requireSpecification(specificationId, "write");
  getDb().delete(bindings).where(eq(bindings.specificationId, specificationId)).run();
  return { ok: true };
}
export function lintDraft(raw: z.input<typeof lintDraftInput>) {
  const input = lintDraftInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "read");
  return lintGovernance(input.source, input.config);
}
export function checkSpecificationGovernance(
  specificationId: string,
  raw: z.input<typeof checkGovernanceInput> = {},
) {
  const input = checkGovernanceInput.parse(raw),
    spec = getSpecification(specificationId, input.version),
    value = effective(specificationId);
  return {
    spec,
    value,
    report: lintGovernance(
      { format: spec.format, entrypoint: spec.entrypoint, files: spec.files },
      value.config,
    ),
  };
}
export function previewGovernance(specificationId: string, raw: z.input<typeof checkGovernanceInput> = {}) {
  const { report } = checkSpecificationGovernance(specificationId, raw);
  return report;
}
export function saveGovernanceReport(
  specificationId: string,
  raw: z.input<typeof checkGovernanceInput> = {},
) {
  requireSpecification(specificationId, "write");
  const { spec, value, report } = checkSpecificationGovernance(specificationId, raw);
  assertStorage(spec.workspaceId);
  const id = newId(),
    createdAt = Math.max(
      Date.now(),
      (getDb()
        .select({ createdAt: reports.createdAt })
        .from(reports)
        .where(eq(reports.specificationId, specificationId))
        .orderBy(desc(reports.createdAt))
        .get()?.createdAt ?? 0) + 1,
    );
  getDb().transaction(() => {
    getDb()
      .insert(reports)
      .values({
        id,
        workspaceId: spec.workspaceId,
        specificationId,
        specVersion: spec.version,
        ruleSetId: value.rule.id,
        ruleVersion: value.rule.version,
        bindingRevision: value.binding.revision,
        report,
        createdAt,
      })
      .run();
    const retained = getDb()
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.specificationId, specificationId))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(GOVERNANCE_LIMITS.reports)
      .all()
      .map((r) => r.id);
    getDb()
      .delete(reports)
      .where(and(eq(reports.specificationId, specificationId), notInArray(reports.id, retained)))
      .run();
  });
  return getGovernanceReport(specificationId, id);
}
export function listGovernanceReports(specificationId: string) {
  requireSpecification(specificationId);
  return getDb()
    .select({
      id: reports.id,
      specVersion: reports.specVersion,
      ruleSetId: reports.ruleSetId,
      ruleVersion: reports.ruleVersion,
      createdAt: reports.createdAt,
      report: reports.report,
    })
    .from(reports)
    .where(eq(reports.specificationId, specificationId))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .all()
    .map(({ report, ...row }) => ({ ...row, summary: report.summary, complete: report.complete }));
}
export function getGovernanceReport(specificationId: string, id: string) {
  requireSpecification(specificationId);
  const row = getDb()
    .select()
    .from(reports)
    .where(and(eq(reports.specificationId, specificationId), eq(reports.id, id)))
    .get();
  if (!row) throw new HttpError(404, "Governance report not found");
  return row;
}
