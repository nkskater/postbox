import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { encryptSecret, decryptSecret } from "@/core/vault/crypto";
import {
  jsonBudget,
  parseGraph,
  referenceKey,
  validateGraph,
  type FlowBundle,
  type FlowGraph,
  type FlowUnit,
} from "@/core/workflows/model";
import { getDb, schema } from "../db";
import { HttpError, notFound } from "../errors";
import { getKeys } from "../vault-keys";
import * as repo from "../repo";
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const aad = (workflowId: string, version: number) => `workflow-${workflowId}-${version}`;
export function sealArtifact(workspaceId: string, workflowId: string, version: number, bundle: FlowBundle) {
  jsonBudget(bundle, MAX_ARTIFACT_BYTES, 48);
  const content = JSON.stringify(bundle);
  return {
    artifact: encryptSecret(getKeys().ring, workspaceId, aad(workflowId, version), content).ciphertext,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}
export function versionRow(workflowId: string, version: number) {
  const row = getDb()
    .select()
    .from(schema.workflowVersions)
    .where(
      and(eq(schema.workflowVersions.workflowId, workflowId), eq(schema.workflowVersions.version, version)),
    )
    .get();
  if (!row) throw notFound("Workflow version");
  return row;
}
export function openArtifact(workspaceId: string, workflowId: string, version: number): FlowBundle {
  const row = versionRow(workflowId, version);
  if (row.workspaceId !== workspaceId) throw notFound("Workflow version");
  try {
    const content = decryptSecret(getKeys().ring, workspaceId, aad(workflowId, version), row.artifact);
    if (createHash("sha256").update(content).digest("hex") !== row.contentHash)
      throw new Error("Snapshot digest mismatch");
    const bundle = JSON.parse(content) as FlowBundle;
    jsonBudget(bundle, MAX_ARTIFACT_BYTES, 48);
    return bundle;
  } catch {
    throw new HttpError(
      409,
      "This workflow snapshot is unreadable; restore its vault key or publish a new version",
    );
  }
}
function snapshotUnit(workspaceId: string, raw: unknown): FlowUnit {
  const graph = parseGraph(raw),
    issues = validateGraph(graph);
  if (issues.length)
    throw new HttpError(
      400,
      issues.map((issue) => `${issue.nodeId ? `${issue.nodeId}: ` : ""}${issue.message}`).join("; "),
    );
  const requests: FlowUnit["requests"] = {};
  for (const node of graph.nodes)
    if (node.type === "request" && !Object.hasOwn(requests, node.requestId)) {
      const row = repo.requireRequestIn(workspaceId, node.requestId);
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(row.url)?.[1].toLowerCase();
      if (
        (scheme ? !["http", "https"].includes(scheme) : !row.url.includes("{{")) ||
        row.settings.socketio ||
        row.settings.mqtt ||
        row.settings.grpc
      )
        throw new HttpError(400, "Workflow request blocks require finite HTTP requests");
      const ancestors = repo.getFolderChain(row.folderId);
      requests[node.requestId] = { request: row, folderId: row.folderId, ancestors };
      jsonBudget(requests, MAX_ARTIFACT_BYTES, 40);
    }
  return { graph, requests };
}
/** Capture request content and every referenced immutable subflow; live secrets/policy/roles are loaded at execution. */
export function compileBundle(workspaceId: string, graph: FlowGraph): FlowBundle {
  try {
    return compile(workspaceId, graph);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid workflow snapshot");
  }
}
function compile(workspaceId: string, graph: FlowGraph): FlowBundle {
  const bundle: FlowBundle = { root: snapshotUnit(workspaceId, graph), subflows: {} };
  const pending = [{ unit: bundle.root, depth: 0 }];
  let bytes = jsonBudget(bundle.root, MAX_ARTIFACT_BYTES, 40);
  while (pending.length) {
    const { unit, depth } = pending.pop()!;
    if (depth > 8) throw new HttpError(400, "Subflow nesting limit exceeded");
    for (const node of unit.graph.nodes)
      if (node.type === "subflow") {
        const workflow = getDb()
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, node.workflowId))
          .get();
        if (!workflow || workflow.workspaceId !== workspaceId) throw notFound("Subflow");
        const key = referenceKey(node.workflowId, node.version);
        if (Object.hasOwn(bundle.subflows, key)) continue;
        if (Object.keys(bundle.subflows).length >= 64)
          throw new HttpError(400, "A workflow may contain at most 64 subflow versions");
        const saved = openArtifact(workspaceId, node.workflowId, node.version);
        for (const [ref, child] of Object.entries({ [key]: saved.root, ...saved.subflows }))
          if (!Object.hasOwn(bundle.subflows, ref)) {
            if (Object.keys(bundle.subflows).length >= 64)
              throw new HttpError(400, "A workflow may contain at most 64 subflow versions");
            bytes += jsonBudget(child, MAX_ARTIFACT_BYTES, 40);
            if (bytes > MAX_ARTIFACT_BYTES)
              throw new HttpError(400, "Workflow snapshots exceed the deployment data budget");
            bundle.subflows[ref] = child;
            pending.push({ unit: child, depth: depth + 1 });
          }
      }
  }
  const active = new Set<string>(),
    measured = new Map<string, number>();
  const nesting = (key: string, unit: FlowUnit): number => {
    if (active.has(key)) throw new HttpError(400, "Subflow cycle detected");
    const known = measured.get(key);
    if (known !== undefined) return known;
    active.add(key);
    let depth = 0;
    for (const node of unit.graph.nodes)
      if (node.type === "subflow") {
        const ref = referenceKey(node.workflowId, node.version),
          child = bundle.subflows[ref];
        if (!child) throw new HttpError(400, "Subflow snapshot is incomplete");
        depth = Math.max(depth, 1 + nesting(ref, child));
      }
    active.delete(key);
    measured.set(key, depth);
    if (depth > 8) throw new HttpError(400, "Subflow nesting limit exceeded");
    return depth;
  };
  nesting("$root", bundle.root);
  if (
    bundle.root.graph.persistVariables &&
    [bundle.root, ...Object.values(bundle.subflows)].some((unit) =>
      unit.graph.nodes.some((node) => node.type === "loop" && node.concurrency > 1),
    )
  )
    throw new HttpError(400, "Persistent variable writes require serial loops, including subflows");
  jsonBudget(bundle, MAX_ARTIFACT_BYTES, 48);
  return bundle;
}
