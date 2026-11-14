import { z, type ZodType } from "zod";
import { json, readBodyText, HttpError } from "../http";
import { bearerToken } from "../auth";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { currentCaller } from "../access-context";
import { authorize } from "../authorize";
import * as flow from "./index";
import { versionRow } from "./artifacts";
import { authorizeTrigger, acceptTrigger, triggerDeployment, triggerResult } from "./deployments";
export type IdContext = { params: Promise<{ id: string }> };
export type VersionContext = { params: Promise<{ id: string; version: string }> };
export async function body<T>(req: Request, validator: ZodType<T>, limit = 524288): Promise<T> {
  const text = await readBodyText(req, limit);
  let value: unknown = {};
  try {
    if (text.trim()) value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return validator.parse(value);
}
const runInput = z
  .object({
    input: z.unknown().optional(),
    environmentId: z.string().min(1).nullable().optional(),
    version: z.number().int().min(1).optional(),
    graph: z.unknown().optional(),
    fixtures: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) => value.version === undefined || value.graph === undefined,
    "Choose a draft graph or a published version",
  );
const revisionInput = z.object({ revision: z.number().int().min(1) }).strict();
const versionNumber = (value: string) => z.coerce.number().int().min(1).max(1000000000).parse(value);
function permissions(workspaceId: string) {
  const can = (action: "read" | "write" | "run" | "manage") => {
    try {
      authorize(currentCaller(), workspaceId, action);
      return true;
    } catch {
      return false;
    }
  };
  return { read: can("read"), write: can("write"), run: can("run"), manage: can("manage") };
}
export async function list(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId") ?? "";
  const workflows = flow.listWorkflows(workspaceId);
  return json({
    workflows,
    permissions: permissions(workspaceId),
    requests: getDb()
      .select({
        id: schema.requests.id,
        name: schema.requests.name,
        url: schema.requests.url,
        method: schema.requests.method,
        folderId: schema.requests.folderId,
      })
      .from(schema.requests)
      .where(eq(schema.requests.workspaceId, workspaceId))
      .all(),
    environments: getDb()
      .select({ id: schema.environments.id, name: schema.environments.name })
      .from(schema.environments)
      .where(eq(schema.environments.workspaceId, workspaceId))
      .all(),
  });
}
export async function create(req: Request) {
  return json(flow.createWorkflow(await body(req, flow.workflowInput)), 201);
}
export async function get(_req: Request, ctx: IdContext) {
  return json(flow.getWorkflow((await ctx.params).id));
}
export async function update(req: Request, ctx: IdContext) {
  return json(flow.updateWorkflow((await ctx.params).id, await body(req, flow.workflowPatch)));
}
export async function remove(_req: Request, ctx: IdContext) {
  flow.deleteWorkflow((await ctx.params).id);
  return json({ ok: true });
}
export async function validate(req: Request, ctx: IdContext) {
  const value = await body(req, z.object({ graph: z.unknown().optional() }).strict());
  return json(flow.validateWorkflow((await ctx.params).id, value.graph));
}
export async function versions(_req: Request, ctx: IdContext) {
  return json(flow.listVersions((await ctx.params).id));
}
export async function publish(req: Request, ctx: IdContext) {
  const value = await body(req, revisionInput);
  return json(flow.publishVersion((await ctx.params).id, value.revision), 201);
}
export async function getVersion(_req: Request, ctx: VersionContext) {
  const { id, version } = await ctx.params;
  flow.getWorkflow(id);
  const row = versionRow(id, versionNumber(version));
  return json({
    workflowId: id,
    version: row.version,
    name: row.name,
    graph: row.graph,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  });
}
export async function removeVersion(_req: Request, ctx: VersionContext) {
  const { id, version } = await ctx.params;
  flow.deleteVersion(id, versionNumber(version));
  return json({ ok: true });
}
async function start(req: Request, ctx: IdContext, source: "fixture" | "manual") {
  const value = await body(req, runInput),
    workflowId = (await ctx.params).id;
  if (source === "manual" && value.fixtures !== undefined)
    throw new HttpError(400, "Use the preview endpoint for request fixtures");
  return json(
    flow.startFlowRun({
      workflowId,
      input: flow.jsonInput(value.input === undefined ? {} : value.input),
      environmentId: value.environmentId,
      version: value.version,
      graph: value.graph,
      source,
      fixtures: value.fixtures as Record<string, flow.FixtureResponse> | undefined,
    }),
    202,
  );
}
export const preview = (req: Request, ctx: IdContext) => start(req, ctx, "fixture");
export const run = (req: Request, ctx: IdContext) => start(req, ctx, "manual");
export async function runs(_req: Request, ctx: IdContext) {
  return json(flow.listFlowRuns((await ctx.params).id));
}
export async function runInfo(_req: Request, ctx: IdContext) {
  return json(flow.getFlowRun((await ctx.params).id));
}
export async function cancel(_req: Request, ctx: IdContext) {
  return json(flow.cancelFlowRun((await ctx.params).id));
}
export async function deployments(_req: Request, ctx: IdContext) {
  return json(flow.listDeployments((await ctx.params).id));
}
export async function deploy(req: Request, ctx: IdContext) {
  return json(flow.createDeployment((await ctx.params).id, await body(req, flow.deploymentInput)), 201);
}
export async function deploymentInfo(_req: Request, ctx: IdContext) {
  return json(flow.getDeployment((await ctx.params).id));
}
export async function updateDeployment(req: Request, ctx: IdContext) {
  return json(flow.updateDeployment((await ctx.params).id, await body(req, flow.deploymentPatch)));
}
export async function removeDeployment(_req: Request, ctx: IdContext) {
  flow.deleteDeployment((await ctx.params).id);
  return json({ ok: true });
}
export async function runDeployment(req: Request, ctx: IdContext) {
  const value = await body(req, z.object({ input: z.unknown().optional() }).strict());
  return json(
    flow.runDeployment(
      (await ctx.params).id,
      value.input === undefined ? undefined : flow.jsonInput(value.input),
    ),
    202,
  );
}
export async function rotate(req: Request, ctx: IdContext) {
  const value = await body(req, revisionInput);
  return json(flow.rotateTriggerToken((await ctx.params).id, value.revision));
}
export async function webhook(req: Request, ctx: IdContext) {
  const { id } = await ctx.params,
    token = bearerToken(req.headers.get("authorization"));
  acceptTrigger(id, token);
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new HttpError(415, "Workflow triggers require application/json");
  const value = flow.jsonInput(await body(req, z.unknown(), 65536));
  const key = req.headers.get("idempotency-key");
  if (key !== null && !/^[\x21-\x7e]{1,128}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key");
  const deployment = authorizeTrigger(id, token),
    started = triggerDeployment(deployment, "webhook", value, key ?? undefined);
  const wait = ["1", "true"].includes(new URL(req.url).searchParams.get("wait") ?? "");
  const result = await triggerResult(id, started.runId, token, wait);
  return json(
    { ...result, duplicate: started.duplicate },
    ["queued", "running"].includes(result.status) ? 202 : 200,
  );
}
export async function webhookStatus(req: Request, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await ctx.params;
  return json(await triggerResult(id, runId, bearerToken(req.headers.get("authorization"))));
}
