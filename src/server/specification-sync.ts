import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db";
import * as repo from "./repo";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { assertStorage } from "./usage";
import {
  createSpecification,
  getSpecification,
  saveSpecification,
  requireSpecification,
} from "./specifications";
import {
  generateOpenApi,
  flattenRequests,
  type OpenApiDocument,
} from "@/core/specifications/generate-openapi";
import {
  importLinkedOpenApi,
  projectRequest,
  type RequestProjection,
  type LinkedOpenApi,
} from "@/core/specifications/linked-openapi";
import {
  stableJson,
  equal,
  mergeThreeWay,
  transferDelta,
  diffValues,
  type SyncConflict,
  type SyncChange,
  type SyncChoice,
} from "@/core/specifications/merge";
import { bundleOpenApiReferences } from "@/core/convert/openapi-references";
import { parseSpec } from "@/core/convert/openapi-document";
import { DEFAULT_SETTINGS } from "@/core/types";
import type { FolderNode, Variable } from "@/core/types";
const { specificationLinks: links } = schema;
export interface SyncBaseline {
  requests: Record<
    string,
    { requestId: string; remote: RequestProjection; collection: RequestProjection; operationId?: string }
  >;
  generated: OpenApiDocument;
  variables: Variable[];
  remoteVariables: Variable[];
  remoteRoot: { name: string; description: string; auth: FolderNode["auth"] };
  sourceUrl?: string;
  root: { name: string; description: string; auth: FolderNode["auth"] };
}
export const syncPreviewInput = z
  .object({ folderId: z.string().min(1), direction: z.enum(["collection", "specification"]) })
  .strict();
export const syncApplyInput = syncPreviewInput
  .extend({
    token: z.string().length(64),
    choices: z.record(z.string(), z.enum(["keep", "take"])).default({}),
  })
  .strict();
export const generateSpecificationInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    apiVersion: z.string().trim().min(1).max(100).default("1.0.0"),
  })
  .strict();
export const generateCollectionInput = z
  .object({
    version: z.number().int().positive().optional(),
    sourceUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
      }, "Use an HTTP(S) source URL without embedded credentials")
      .optional(),
  })
  .strict();
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
function collection(folderId: string, action: "read" | "write") {
  const folder = repo.getFolder(folderId);
  if (!folder) throw new HttpError(404, "Collection not found");
  authorize(currentCaller(), folder.workspaceId, action);
  if (folder.parentId) throw new HttpError(400, "Link a top-level collection");
  return {
    folder,
    root: repo.getFolderTree(folderId)!,
    variables: repo.listVariables(folder.workspaceId, "collection", folderId),
  };
}
export function getCollectionSpecification(folderId: string) {
  collection(folderId, "read");
  const link = getDb().select().from(links).where(eq(links.folderId, folderId)).get();
  if (!link) return null;
  const spec = requireSpecification(link.specificationId);
  return {
    folderId,
    specificationId: link.specificationId,
    specVersion: link.specVersion,
    latestVersion: spec.revision,
    revision: link.revision,
    name: spec.name,
  };
}
export function listSpecificationCollections(specificationId: string) {
  requireSpecification(specificationId);
  return getDb()
    .select({ folderId: links.folderId, specVersion: links.specVersion, revision: links.revision })
    .from(links)
    .where(eq(links.specificationId, specificationId))
    .all()
    .map((link) => ({ ...link, name: repo.getFolder(link.folderId)?.name ?? "Collection" }));
}
async function converted(specificationId: string, version?: number, sourceUrl?: string) {
  const doc = getSpecification(specificationId, version);
  if (doc.format !== "openapi")
    throw new HttpError(400, "Collection synchronization requires an OpenAPI specification");
  if (!doc.analysis.valid)
    throw new HttpError(400, "Resolve specification diagnostics before generating a collection");
  try {
    const bundled = await bundleOpenApiReferences({
      files: doc.files,
      entrypoint: doc.entrypoint,
      sourceUrl,
    });
    return { doc, model: importLinkedOpenApi(bundled.document, bundled.sourceUrl) };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}
const rootProjection = (root: FolderNode) => ({
  name: root.name,
  description: root.description ?? "",
  auth: root.auth,
});
function mapRequests(model: LinkedOpenApi, root: FolderNode, sourceIds = false) {
  const actual = flattenRequests(root),
    used = new Set<string>(),
    requests: SyncBaseline["requests"] = Object.create(null);
  for (const op of model.operations) {
    let match = sourceIds && op.sourceRequestId ? actual.find((r) => r.id === op.sourceRequestId) : undefined;
    if (!match)
      match = actual.find(
        (r) =>
          !used.has(r.id) &&
          r.method === op.request.method &&
          r.url === op.request.url &&
          r.name === op.request.name,
      );
    if (!match) throw new HttpError(400, "Generated operation could not be linked to its request");
    used.add(match.id);
    requests[op.key] = {
      requestId: match.id,
      remote: op.request,
      collection: projectRequest(match),
      operationId: op.operationId,
    };
  }
  return requests;
}
function generated(
  root: FolderNode,
  variables: Variable[],
  requests: SyncBaseline["requests"],
  apiVersion?: string,
) {
  return generateOpenApi(root, variables, {
    operationIds: Object.fromEntries(Object.values(requests).map((r) => [r.requestId, r.operationId])),
    apiVersion,
  });
}
export async function generateCollection(
  specificationId: string,
  raw: z.input<typeof generateCollectionInput> = {},
) {
  const input = generateCollectionInput.parse(raw),
    spec = requireSpecification(specificationId, "write"),
    { doc, model } = await converted(specificationId, input.version, input.sourceUrl);
  return getDb().transaction(() => {
    requireSpecification(specificationId, "write");
    assertStorage(spec.workspaceId);
    const result = repo.importTree(spec.workspaceId, model.root, model.variables),
      root = repo.getFolderTree(result.id)!,
      requests = mapRequests(model, root),
      baseline: SyncBaseline = {
        requests,
        generated: generated(root, model.variables, requests).document,
        variables: model.variables,
        remoteVariables: model.variables,
        remoteRoot: rootProjection(model.root),
        sourceUrl: input.sourceUrl,
        root: rootProjection(root),
      };
    getDb()
      .insert(links)
      .values({
        folderId: result.id,
        workspaceId: spec.workspaceId,
        specificationId,
        specVersion: doc.version,
        baseline,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    return { ...result, specificationId, specVersion: doc.version, warnings: model.warnings };
  });
}
export function generateSpecification(
  folderId: string,
  raw: z.input<typeof generateSpecificationInput> = {},
) {
  const input = generateSpecificationInput.parse(raw),
    { folder, root, variables } = collection(folderId, "write");
  if (getCollectionSpecification(folderId))
    throw new HttpError(409, "Collection already has a linked specification");
  try {
    const result = generateOpenApi(root, variables, { apiVersion: input.apiVersion }),
      model = importLinkedOpenApi(result.document);
    return getDb().transaction(() => {
      const spec = createSpecification({
          workspaceId: folder.workspaceId,
          name: input.name ?? root.name,
          format: "openapi",
          entrypoint: "openapi.json",
          files: [{ path: "openapi.json", content: JSON.stringify(result.document, null, 2) }],
          label: "Generated from collection",
        }),
        requests = mapRequests(model, root, true),
        baseline: SyncBaseline = {
          requests,
          generated: result.document,
          variables,
          remoteVariables: model.variables,
          remoteRoot: rootProjection(model.root),
          root: rootProjection(root),
        };
      getDb()
        .insert(links)
        .values({
          folderId,
          workspaceId: folder.workspaceId,
          specificationId: spec.id,
          specVersion: spec.version,
          baseline,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      return { ...spec, warnings: result.warnings };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, (error as Error).message);
  }
}
export function unlinkSpecification(folderId: string) {
  collection(folderId, "write");
  getDb().delete(links).where(eq(links.folderId, folderId)).run();
  return { ok: true };
}
interface Captured {
  link: typeof links.$inferSelect;
  root: FolderNode;
  variables: Variable[];
  spec: ReturnType<typeof getSpecification>;
  fingerprint: string;
}
function capture(specificationId: string, folderId: string, action: "read" | "write"): Captured {
  const spec = getSpecification(specificationId);
  requireSpecification(specificationId, action);
  const { folder, root, variables } = collection(folderId, action),
    link = getDb()
      .select()
      .from(links)
      .where(and(eq(links.folderId, folderId), eq(links.specificationId, specificationId)))
      .get();
  if (!link || folder.workspaceId !== spec.workspaceId)
    throw new HttpError(404, "Specification link not found");
  return { link, root, variables, spec, fingerprint: digest({ link, root, variables, spec }) };
}
function publicResult(
  token: string,
  changes: SyncChange[],
  conflicts: SyncConflict[],
  warnings: string[],
  specVersion: number,
  linkRevision: number,
) {
  return {
    token,
    changes,
    conflicts,
    warnings,
    specVersion,
    linkRevision,
    inSync: changes.length === 0 && conflicts.length === 0,
  };
}
async function plan(
  specificationId: string,
  input: z.infer<typeof syncPreviewInput>,
  choices: Record<string, SyncChoice> = {},
) {
  const state = capture(specificationId, input.folderId, "read"),
    { link, root, variables, spec } = state,
    baseline = link.baseline,
    token = digest({ fingerprint: state.fingerprint, direction: input.direction });
  let changes: SyncChange[] = [],
    conflicts: SyncConflict[] = [],
    warnings: string[] = [];
  let document: OpenApiDocument | undefined;
  const updates: { key: string; requestId?: string; value: RequestProjection | undefined }[] = [],
    remote = await converted(specificationId, undefined, baseline.sourceUrl),
    current = new Map(flattenRequests(root).map((r) => [r.id, r])),
    nextRoot = rootProjection(root);
  if (input.direction === "specification") {
    if (spec.files.length !== 1)
      throw new HttpError(
        400,
        "Collection-to-spec synchronization requires a single-file source; export a consolidated document first",
      );
    const generatedResult = generated(
      root,
      variables,
      baseline.requests,
      String((parseSpec(spec.files[0].content).info as Record<string, unknown>)?.version ?? "1.0.0"),
    );
    warnings = [...remote.model.warnings, ...generatedResult.warnings];
    const merge = mergeThreeWay(
      baseline.generated,
      parseSpec(spec.files[0].content),
      generatedResult.document,
      choices,
    );
    document = merge.value as OpenApiDocument;
    changes = merge.changes;
    conflicts = merge.conflicts;
  } else {
    warnings = remote.model.warnings;
    const incoming = new Map(remote.model.operations.map((op) => [op.key, op]));
    for (const key of new Set([...Object.keys(baseline.requests), ...incoming.keys()])) {
      const previous = baseline.requests[key],
        op = incoming.get(key),
        local = previous ? current.get(previous.requestId) : undefined;
      const prefix = "/requests/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
      const desired = op
        ? previous
          ? transferDelta(previous.remote, previous.collection, op.request)
          : op.request
        : undefined;
      if (previous && op && !local && equal(previous.remote, op.request)) continue;
      let merge = mergeThreeWay(
        previous?.collection,
        local ? projectRequest(local) : undefined,
        desired,
        choices,
        prefix,
      );
      if (
        previous &&
        !op &&
        local &&
        (local.preRequestScript ||
          local.testScript ||
          local.examples?.length ||
          !equal(local.settings, DEFAULT_SETTINGS)) &&
        !merge.conflicts.length
      ) {
        const conflict = {
          path: prefix,
          base: previous.collection,
          current: projectRequest(local),
          incoming: null,
          resolved: !!choices[prefix],
        };
        merge = {
          value: choices[prefix] === "take" ? undefined : projectRequest(local),
          conflicts: [conflict],
          changes: choices[prefix] === "take" ? diffValues(projectRequest(local), undefined, prefix) : [],
        };
      }
      changes.push(...merge.changes);
      conflicts.push(...merge.conflicts);
      updates.push({
        key,
        requestId: previous?.requestId,
        value: merge.value as RequestProjection | undefined,
      });
    }
    const rootMerge = mergeThreeWay(
      baseline.root,
      rootProjection(root),
      transferDelta(baseline.remoteRoot, baseline.root, rootProjection(remote.model.root)),
      choices,
      "/collection",
    );
    Object.assign(nextRoot, rootMerge.value);
    changes.push(...rootMerge.changes);
    conflicts.push(...rootMerge.conflicts);
    const variableMerge = mergeThreeWay(
      baseline.variables,
      variables,
      transferDelta(baseline.remoteVariables, baseline.variables, remote.model.variables),
      choices,
      "/variables",
    );
    changes.push(...variableMerge.changes);
    conflicts.push(...variableMerge.conflicts);
    return {
      state,
      remote,
      updates,
      nextRoot,
      nextVariables: variableMerge.value as Variable[],
      document,
      result: publicResult(token, changes, conflicts, warnings, spec.version, link.revision),
    };
  }
  return {
    state,
    remote,
    updates,
    nextRoot,
    nextVariables: variables,
    document,
    result: publicResult(token, changes, conflicts, warnings, spec.version, link.revision),
  };
}
export async function previewSpecificationSync(
  specificationId: string,
  raw: z.input<typeof syncPreviewInput>,
) {
  const input = syncPreviewInput.parse(raw);
  try {
    return (await plan(specificationId, input)).result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, (error as Error).message);
  }
}
export async function applySpecificationSync(specificationId: string, raw: z.input<typeof syncApplyInput>) {
  const input = syncApplyInput.parse(raw);
  capture(specificationId, input.folderId, "write");
  const preview = await plan(specificationId, input, input.choices);
  if (preview.result.token !== input.token)
    throw new HttpError(409, "Preview is stale; review the changes again");
  if (preview.result.conflicts.some((c) => !c.resolved))
    throw new HttpError(409, "Resolve every conflict before applying");
  return getDb().transaction(() => {
    if (capture(specificationId, input.folderId, "write").fingerprint !== preview.state.fingerprint)
      throw new HttpError(409, "Preview is stale; review the changes again");
    const { state, updates, nextRoot, nextVariables, remote } = preview;
    let spec = state.spec;
    if (preview.result.inSync && state.link.specVersion === spec.version)
      return {
        ...preview.result,
        applied: true,
        specificationId,
        folderId: input.folderId,
        specVersion: spec.version,
      };
    if (input.direction === "specification" && preview.result.changes.length)
      spec = saveSpecification(specificationId, {
        expectedRevision: spec.revision,
        entrypoint: spec.entrypoint,
        files: [{ path: spec.entrypoint, content: JSON.stringify(preview.document, null, 2) }],
        label: "Synchronized from collection",
      });
    const mapping: SyncBaseline["requests"] = { ...state.link.baseline.requests };
    if (input.direction === "collection") {
      for (const update of updates) {
        if (!update.value) {
          if (update.requestId) repo.deleteRequest(update.requestId);
          const op = remote.model.operations.find((o) => o.key === update.key);
          if (op && mapping[update.key]) mapping[update.key] = { ...mapping[update.key], remote: op.request };
          else delete mapping[update.key];
          continue;
        }
        let request = update.requestId ? repo.getRequest(update.requestId) : null;
        if (request) request = repo.updateRequest(request.id, update.value);
        else request = repo.createRequest(spec.workspaceId, input.folderId, update.value);
        const op = remote.model.operations.find((o) => o.key === update.key);
        if (op)
          mapping[update.key] = {
            requestId: request!.id,
            remote: op.request,
            collection: projectRequest(request!),
            operationId: op.operationId,
          };
      }
      repo.updateFolder(input.folderId, nextRoot);
      repo.replaceVariables(spec.workspaceId, "collection", input.folderId, nextVariables);
    }
    const root = repo.getFolderTree(input.folderId)!,
      variables = repo.listVariables(spec.workspaceId, "collection", input.folderId);
    for (const item of Object.values(mapping)) {
      const request = repo.getRequest(item.requestId);
      if (request) item.collection = projectRequest(request);
    }
    const latestModel =
      input.direction === "specification"
        ? importLinkedOpenApi(
            parseSpec(spec.files.find((f) => f.path === spec.entrypoint)!.content),
            state.link.baseline.sourceUrl,
          )
        : remote.model;
    for (const op of latestModel.operations) {
      let mapped = mapping[op.key];
      if (!mapped && op.sourceRequestId) {
        const request = flattenRequests(root).find((r) => r.id === op.sourceRequestId);
        if (request)
          mapped = {
            requestId: request.id,
            remote: op.request,
            collection: projectRequest(request),
            operationId: op.operationId,
          };
      }
      if (mapped) mapping[op.key] = { ...mapped, remote: op.request };
    }
    const keys = new Set(latestModel.operations.map((op) => op.key));
    for (const key of Object.keys(mapping)) if (!keys.has(key)) delete mapping[key];
    const baseline: SyncBaseline = {
      requests: mapping,
      generated: generated(root, variables, mapping).document,
      variables,
      remoteVariables: latestModel.variables,
      remoteRoot: rootProjection(latestModel.root),
      sourceUrl: state.link.baseline.sourceUrl,
      root: rootProjection(root),
    };
    getDb()
      .update(links)
      .set({ baseline, specVersion: spec.version, revision: state.link.revision + 1, updatedAt: Date.now() })
      .where(eq(links.folderId, input.folderId))
      .run();
    return {
      ...preview.result,
      applied: true,
      specificationId,
      folderId: input.folderId,
      specVersion: spec.version,
    };
  });
}
