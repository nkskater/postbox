import { and, desc, eq, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { Cron } from "croner";
import { z } from "zod";
import type { Json } from "@/core/workflows/model";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { getDb, schema } from "../db";
import { currentCaller } from "../access-context";
import { authorize } from "../authorize";
import { safeEqual } from "../auth";
import { newId } from "../defaults";
import { HttpError, notFound } from "../errors";
import * as repo from "../repo";
import { validCron } from "../scheduler";
import { assertStorage } from "../usage";
import { captureActor, resolveActor } from "./actor";
import { openArtifact, versionRow } from "./artifacts";
import { jsonInput, row } from "./repo";
import { flowRunRow, startFlowRun, waitForFlowRun } from "./runner";
import { cancelMatching, flowState } from "./state";
const table = schema.workflowDeployments;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => `wf_${randomBytes(32).toString("base64url")}`;
export const validWorkflowCron = (value: string) =>
  value.trim().split(/\s+/).length === 5 && validCron(value);
const fields = {
  name: z.string().trim().min(1).max(200),
  version: z.number().int().min(1),
  environmentId: z.string().min(1).nullable(),
  enabled: z.boolean(),
  cron: z
    .string()
    .trim()
    .max(100)
    .refine(validWorkflowCron, "Use a five-field UTC cron expression with a future occurrence")
    .nullable(),
  webhookEnabled: z.boolean(),
  input: z.unknown(),
};
export const deploymentInput = z
  .object({
    ...fields,
    environmentId: fields.environmentId.optional(),
    enabled: fields.enabled.default(false),
    cron: fields.cron.optional(),
    webhookEnabled: fields.webhookEnabled.default(false),
    input: fields.input.optional(),
  })
  .strict();
export const deploymentPatch = z
  .object({
    ...fields,
    name: fields.name.optional(),
    version: fields.version.optional(),
    environmentId: fields.environmentId.optional(),
    enabled: fields.enabled.optional(),
    cron: fields.cron.optional(),
    webhookEnabled: fields.webhookEnabled.optional(),
    input: fields.input.optional(),
    revision: z.number().int().min(1),
  })
  .strict();
export function deploymentRow(id: string) {
  const found = getDb().select().from(table).where(eq(table.id, id)).get();
  if (!found) throw notFound("Workflow deployment");
  return found;
}
function validate(workspaceId: string, workflowId: string, version: number, environmentId: string | null) {
  const saved = versionRow(workflowId, version);
  if (saved.workspaceId !== workspaceId) throw notFound("Workflow version");
  if (environmentId) {
    const env = repo.getEnvironment(environmentId);
    if (!env || env.workspaceId !== workspaceId)
      throw new HttpError(400, "Environment is unavailable in this workspace");
  }
}
function view(deployment: ReturnType<typeof deploymentRow>) {
  let nextRun: string | null = null;
  if (deployment.enabled && deployment.cron) {
    let job: Cron | undefined;
    try {
      job = new Cron(deployment.cron, { paused: true, timezone: "UTC" });
      nextRun = job.nextRun()?.toISOString() ?? null;
    } finally {
      job?.stop();
    }
  }
  const { webhookHash: _hash, ...safe } = deployment;
  return {
    ...safe,
    nextRun,
    webhookConfigured: !!deployment.webhookHash,
    endpoint: `/api/workflow-triggers/${deployment.id}`,
  };
}
export function listDeployments(workflowId: string) {
  const flow = row(workflowId);
  authorize(currentCaller(), flow.workspaceId, "read");
  return getDb()
    .select()
    .from(table)
    .where(eq(table.workflowId, workflowId))
    .orderBy(desc(table.createdAt))
    .all()
    .map(view);
}
export function getDeployment(id: string) {
  const deployment = deploymentRow(id);
  authorize(currentCaller(), deployment.workspaceId, "read");
  return view(deployment);
}
export function createDeployment(workflowId: string, input: z.input<typeof deploymentInput>) {
  const parsed = deploymentInput.parse(input),
    flow = row(workflowId);
  authorize(currentCaller(), flow.workspaceId, "manage");
  assertStorage(flow.workspaceId);
  if (
    getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(table)
      .where(eq(table.workspaceId, flow.workspaceId))
      .get()!.n >= 50
  )
    throw new HttpError(409, "A workspace may contain at most 50 deployments");
  const environmentId = parsed.environmentId ?? null,
    actor = captureActor();
  validate(flow.workspaceId, workflowId, parsed.version, environmentId);
  resolveActor(actor, flow.workspaceId);
  if (parsed.enabled) openArtifact(flow.workspaceId, workflowId, parsed.version);
  const secret = parsed.webhookEnabled ? token() : null,
    now = Date.now();
  const deployment = {
    id: newId(),
    workspaceId: flow.workspaceId,
    workflowId,
    version: parsed.version,
    name: parsed.name,
    revision: 1,
    environmentId,
    enabled: parsed.enabled,
    cron: parsed.cron ?? null,
    webhookEnabled: parsed.webhookEnabled,
    webhookHash: secret ? hash(secret) : null,
    actor,
    input: jsonInput(parsed.input === undefined ? {} : parsed.input),
    lastRunId: null,
    lastError: null,
    lastTriggeredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .insert(table)
    .values({ ...deployment, input: sql`${JSON.stringify(deployment.input)}` })
    .run();
  flowState.refreshSchedules?.();
  return { ...getDeployment(deployment.id), ...(secret ? { token: secret } : {}) };
}
export function updateDeployment(id: string, input: z.input<typeof deploymentPatch>) {
  const patch = deploymentPatch.parse(input),
    old = deploymentRow(id);
  authorize(currentCaller(), old.workspaceId, "manage");
  assertStorage(old.workspaceId);
  if (old.revision !== patch.revision) throw new HttpError(409, "Deployment changed; reload before saving");
  const actor = captureActor(),
    changedActor = JSON.stringify(actor) !== JSON.stringify(old.actor),
    next = {
      ...old,
      ...patch,
      actor,
      input: patch.input === undefined ? old.input : jsonInput(patch.input),
      revision: old.revision + 1,
      updatedAt: Date.now(),
    };
  validate(
    next.workspaceId,
    next.workflowId,
    next.version,
    next.enabled || next.environmentId !== old.environmentId ? next.environmentId : null,
  );
  resolveActor(actor, next.workspaceId);
  if (next.enabled) openArtifact(next.workspaceId, next.workflowId, next.version);
  const secret = next.webhookEnabled && (!old.webhookHash || changedActor) ? token() : null;
  if (secret) next.webhookHash = hash(secret);
  else if (changedActor) next.webhookHash = null;
  const updated = getDb()
    .update(table)
    .set({ ...next, input: sql`${JSON.stringify(next.input)}` })
    .where(and(eq(table.id, id), eq(table.revision, patch.revision)))
    .returning()
    .get();
  if (!updated) throw new HttpError(409, "Deployment changed; reload before saving");
  cancelMatching((active) => active.deploymentId === id);
  flowState.refreshSchedules?.();
  return { ...getDeployment(id), ...(secret ? { token: secret } : {}) };
}
export function rotateTriggerToken(id: string, revision: number) {
  const deployment = deploymentRow(id);
  authorize(currentCaller(), deployment.workspaceId, "manage");
  const secret = token();
  const changed = getDb()
    .update(table)
    .set({ webhookHash: hash(secret), revision: sql`${table.revision}+1`, updatedAt: Date.now() })
    .where(and(eq(table.id, id), eq(table.revision, revision)))
    .returning()
    .get();
  if (!changed) throw new HttpError(409, "Deployment changed; reload before rotating its token");
  cancelMatching((active) => active.deploymentId === id);
  return { ...getDeployment(id), token: secret };
}
export function deleteDeployment(id: string) {
  const deployment = deploymentRow(id);
  authorize(currentCaller(), deployment.workspaceId, "manage");
  if (deployment.enabled) throw new HttpError(409, "Disable this deployment before deleting it");
  cancelMatching((active) => active.deploymentId === id);
  getDb().delete(table).where(eq(table.id, id)).run();
  flowState.refreshSchedules?.();
}
export function runDeployment(id: string, input?: Json) {
  const deployment = deploymentRow(id);
  authorize(currentCaller(), deployment.workspaceId, "run");
  return triggerDeployment(deployment, "manual", input === undefined ? deployment.input : input);
}
export function triggerDeployment(
  deployment: ReturnType<typeof deploymentRow>,
  source: "manual" | "schedule" | "webhook",
  input: Json,
  key?: string,
) {
  const live = deploymentRow(deployment.id);
  if (!live.enabled) throw new HttpError(409, "Workflow deployment is disabled");
  const result = startFlowRun({
    workflowId: live.workflowId,
    version: live.version,
    environmentId: live.environmentId,
    input,
    source,
    actor: live.actor,
    deploymentId: live.id,
    idempotencyKey: key,
  });
  getDb()
    .update(table)
    .set({ lastRunId: result.runId, lastError: null, lastTriggeredAt: Date.now() })
    .where(eq(table.id, live.id))
    .run();
  return result;
}
const triggerLimiter = new FixedWindowLimiter();
export function authorizeTrigger(id: string, bearer: string | null) {
  const deployment = getDb().select().from(table).where(eq(table.id, id)).get();
  if (
    !deployment?.enabled ||
    !deployment.webhookEnabled ||
    !deployment.webhookHash ||
    !bearer ||
    !safeEqual(hash(bearer), deployment.webhookHash)
  )
    throw new HttpError(404, "Workflow trigger is unavailable");
  resolveActor(deployment.actor, deployment.workspaceId);
  return deployment;
}
export function acceptTrigger(id: string, bearer: string | null) {
  const deployment = authorizeTrigger(id, bearer);
  if (!triggerLimiter.hit(id, 60, 60000, Date.now()).allowed)
    throw new HttpError(429, "Workflow trigger rate limit exceeded");
  return deployment;
}
export async function triggerResult(id: string, runId: string, bearer: string | null, wait = false) {
  const deployment = authorizeTrigger(id, bearer),
    initial = flowRunRow(runId);
  if (initial.deploymentId !== deployment.id) throw notFound("Workflow run");
  const result = wait ? await waitForFlowRun(runId) : initial;
  authorizeTrigger(id, bearer);
  return {
    runId: result.id,
    status: result.status,
    output: result.output,
    error: result.error,
    steps: result.steps,
    durationMs: result.durationMs,
  };
}
