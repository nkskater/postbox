import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { specificationSource, SPEC_LIMITS } from "@/core/specifications/model";
import { analyzeSpecification } from "@/core/specifications/analyze";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { assertStorage } from "./usage";
const { specifications: specs, specificationVersions: versions } = schema;
export const createSpecificationInput = specificationSource
  .extend({
    workspaceId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    label: z.string().trim().max(200).default(""),
  })
  .strict();
export const saveSpecificationInput = specificationSource
  .omit({ format: true })
  .extend({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    label: z.string().trim().max(200).default(""),
  })
  .strict();
export const validateSpecificationInput = specificationSource
  .extend({ workspaceId: z.string().min(1) })
  .strict();
export function requireSpecification(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(specs).where(eq(specs.id, id)).get();
  if (!row) throw new HttpError(404, "Specification not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
export function listSpecifications(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(specs)
    .where(eq(specs.workspaceId, workspaceId))
    .orderBy(desc(specs.updatedAt))
    .all();
}
export function getSpecification(id: string, version?: number) {
  const row = requireSpecification(id);
  if (version !== undefined && (!Number.isInteger(version) || version < 1))
    throw new HttpError(400, "Invalid version");
  const stored = getDb()
    .select()
    .from(versions)
    .where(and(eq(versions.specificationId, id), eq(versions.version, version ?? row.revision)))
    .get();
  if (!stored) throw new HttpError(404, "Specification version not found");
  return {
    ...row,
    ...stored,
    analysis: analyzeSpecification({
      format: row.format,
      entrypoint: stored.entrypoint,
      files: stored.files,
    }),
    versions: getDb()
      .select({ version: versions.version, label: versions.label, createdAt: versions.createdAt })
      .from(versions)
      .where(eq(versions.specificationId, id))
      .orderBy(desc(versions.version))
      .all(),
  };
}
function validateStorage(source: z.infer<typeof specificationSource>, workspaceId: string) {
  const analysis = analyzeSpecification({
    format: source.format,
    entrypoint: source.entrypoint,
    files: source.files,
  });
  if (analysis.diagnostics.some((d) => d.code === "limit" || d.code === "file"))
    throw new HttpError(400, analysis.diagnostics.map((d) => d.message).join("; "));
  assertStorage(workspaceId);
  return analysis;
}
export function createSpecification(raw: z.input<typeof createSpecificationInput>) {
  const input = createSpecificationInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  if (listSpecifications(input.workspaceId).length >= SPEC_LIMITS.specifications)
    throw new HttpError(429, "At most 100 specifications per workspace");
  validateStorage(input, input.workspaceId);
  const id = newId(),
    now = Date.now();
  getDb().transaction(() => {
    getDb()
      .insert(specs)
      .values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        format: input.format,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getDb()
      .insert(versions)
      .values({
        specificationId: id,
        version: 1,
        entrypoint: input.entrypoint,
        files: input.files,
        label: input.label,
        createdAt: now,
      })
      .run();
  });
  return getSpecification(id);
}
export function saveSpecification(id: string, raw: z.input<typeof saveSpecificationInput>) {
  const row = requireSpecification(id, "write"),
    input = saveSpecificationInput.parse(raw);
  if (row.revision !== input.expectedRevision)
    throw new HttpError(409, "Specification changed; reload before saving");
  if (row.revision >= SPEC_LIMITS.versions)
    throw new HttpError(
      429,
      "At most 100 versions per specification; export/archive before creating a new document",
    );
  validateStorage({ ...input, format: row.format }, row.workspaceId);
  const revision = row.revision + 1,
    now = Date.now();
  getDb().transaction(() => {
    const changed = getDb()
      .update(specs)
      .set({ revision, updatedAt: now, ...(input.name ? { name: input.name } : {}) })
      .where(and(eq(specs.id, id), eq(specs.revision, input.expectedRevision)))
      .run();
    if (!changed.changes) throw new HttpError(409, "Specification changed; reload before saving");
    getDb()
      .insert(versions)
      .values({
        specificationId: id,
        version: revision,
        entrypoint: input.entrypoint,
        files: input.files,
        label: input.label,
        createdAt: now,
      })
      .run();
  });
  return getSpecification(id);
}
export function deleteSpecification(id: string) {
  requireSpecification(id, "write");
  getDb().delete(specs).where(eq(specs.id, id)).run();
  return { ok: true };
}
export function validateSpecification(raw: z.input<typeof validateSpecificationInput>) {
  const input = validateSpecificationInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "read");
  return analyzeSpecification({ format: input.format, entrypoint: input.entrypoint, files: input.files });
}
