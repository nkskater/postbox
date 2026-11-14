import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { jsonBudget, parseGraph, starterGraph, validateGraph, type FlowGraph } from "@/core/workflows/model";
import { keyIdOfCiphertext } from "@/core/vault/crypto";
import { getDb, schema } from "../db";
import { newId } from "../defaults";
import { currentCaller } from "../access-context";
import { authorize } from "../authorize";
import { HttpError, notFound } from "../errors";
import { assertStorage } from "../usage";
import { getKeys } from "../vault-keys";
import { compileBundle, sealArtifact, versionRow } from "./artifacts";
const { workflows: table, workflowVersions: versions } = schema;
const name = z.string().trim().min(1).max(200),
  description = z.string().max(2000);
export const workflowInput = z
  .object({
    workspaceId: z.string().min(1),
    name,
    description: description.optional(),
    graph: z.unknown().optional(),
  })
  .strict();
export const workflowPatch = z
  .object({
    name: name.optional(),
    description: description.optional(),
    graph: z.unknown().optional(),
    revision: z.number().int().min(1),
  })
  .strict();
export function row(id: string) {
  const found = getDb().select().from(table).where(eq(table.id, id)).get();
  if (!found) throw notFound("Workflow");
  return found;
}
export function checkedGraph(value: unknown): FlowGraph {
  try {
    return parseGraph(value);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid workflow graph");
  }
}
export function listWorkflows(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(table)
    .where(eq(table.workspaceId, workspaceId))
    .orderBy(desc(table.updatedAt))
    .all()
    .map(({ graph: _graph, ...flow }) => ({
      ...flow,
      latestVersion: getDb()
        .select({ version: sql<number>`COALESCE(MAX(${versions.version}),0)` })
        .from(versions)
        .where(eq(versions.workflowId, flow.id))
        .get()!.version,
    }));
}
export function getWorkflow(id: string) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "read");
  return { ...flow, issues: validateGraph(flow.graph), versions: listVersions(id) };
}
export function createWorkflow(input: z.input<typeof workflowInput>) {
  const parsed = workflowInput.parse(input);
  authorize(currentCaller(), parsed.workspaceId, "write");
  assertStorage(parsed.workspaceId);
  if (
    getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(table)
      .where(eq(table.workspaceId, parsed.workspaceId))
      .get()!.n >= 100
  )
    throw new HttpError(409, "A workspace may contain at most 100 workflows");
  const graph = parsed.graph === undefined ? starterGraph() : checkedGraph(parsed.graph),
    now = Date.now(),
    caller = currentCaller();
  const flow = {
    id: newId(),
    workspaceId: parsed.workspaceId,
    name: parsed.name,
    description: parsed.description ?? "",
    graph,
    revision: 1,
    createdBy: caller?.kind === "user" ? caller.user.id : null,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(table).values(flow).run();
  return getWorkflow(flow.id);
}
export function updateWorkflow(id: string, input: z.input<typeof workflowPatch>) {
  const parsed = workflowPatch.parse(input),
    flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "write");
  assertStorage(flow.workspaceId);
  const updated = getDb()
    .update(table)
    .set({
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.graph !== undefined ? { graph: checkedGraph(parsed.graph) } : {}),
      revision: sql`${table.revision}+1`,
      updatedAt: Date.now(),
    })
    .where(and(eq(table.id, id), eq(table.revision, parsed.revision)))
    .returning()
    .get();
  if (!updated) throw new HttpError(409, "Workflow changed; reload before saving your edits");
  return getWorkflow(id);
}
export function listVersions(id: string) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "read");
  return getDb()
    .select({
      version: versions.version,
      name: versions.name,
      contentHash: versions.contentHash,
      createdAt: versions.createdAt,
      createdBy: versions.createdBy,
      artifact: versions.artifact,
    })
    .from(versions)
    .where(eq(versions.workflowId, id))
    .orderBy(desc(versions.version))
    .all()
    .map(({ artifact, ...version }) => ({
      ...version,
      readable: getKeys().ring.all.has(keyIdOfCiphertext(artifact) ?? ""),
    }));
}
export function publishVersion(id: string, revision: number) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "manage");
  assertStorage(flow.workspaceId);
  if (flow.revision !== revision) throw new HttpError(409, "Workflow changed; reload before publishing");
  const bundle = compileBundle(flow.workspaceId, flow.graph);
  return getDb().transaction((tx) => {
    if (row(id).revision !== revision) throw new HttpError(409, "Workflow changed while publishing");
    const previous = tx
      .select({ version: sql<number>`COALESCE(MAX(${versions.version}),0)`, count: sql<number>`COUNT(*)` })
      .from(versions)
      .where(eq(versions.workflowId, id))
      .get()!;
    if (previous.count >= 100)
      throw new HttpError(409, "Remove an unused version before publishing more than 100 versions");
    const version = row(id).publishedVersion + 1,
      caller = currentCaller(),
      sealed = sealArtifact(flow.workspaceId, id, version, bundle);
    tx.insert(versions)
      .values({
        workflowId: id,
        workspaceId: flow.workspaceId,
        version,
        name: flow.name,
        graph: flow.graph,
        ...sealed,
        createdAt: Date.now(),
        createdBy: caller?.kind === "user" ? caller.user.id : null,
      })
      .run();
    tx.update(table).set({ publishedVersion: version }).where(eq(table.id, id)).run();
    return { workflowId: id, version, contentHash: sealed.contentHash };
  });
}
export function deleteVersion(id: string, version: number) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "manage");
  versionRow(id, version);
  if (
    getDb()
      .select()
      .from(schema.workflowDeployments)
      .where(
        and(eq(schema.workflowDeployments.workflowId, id), eq(schema.workflowDeployments.version, version)),
      )
      .get()
  )
    throw new HttpError(409, "Delete deployments using this version first");
  getDb()
    .delete(versions)
    .where(and(eq(versions.workflowId, id), eq(versions.version, version)))
    .run();
}
export function validateWorkflow(id: string, graph?: unknown) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "read");
  const parsed = graph === undefined ? flow.graph : checkedGraph(graph),
    issues = validateGraph(parsed);
  if (!issues.length)
    try {
      compileBundle(flow.workspaceId, parsed);
    } catch (error) {
      issues.push({ message: error instanceof Error ? error.message : "Invalid workflow references" });
    }
  return { valid: !issues.length, issues };
}
export function deleteWorkflowRow(id: string) {
  const flow = row(id);
  authorize(currentCaller(), flow.workspaceId, "manage");
  getDb().delete(table).where(eq(table.id, id)).run();
}
export function jsonInput(value: unknown) {
  try {
    jsonBudget(value);
    return value as import("@/core/workflows/model").Json;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid workflow data");
  }
}
