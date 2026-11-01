/**
 * Shared gRPC definition sets: .proto files stored once per workspace and referenced by many
 * requests through settings.grpc.definitionId. Files are validated on save, so a set that exists
 * can always be loaded.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadProtoRoot, MAX_PROTO_FILES, ProtoError } from "@/core/grpc/proto";
import { currentCaller } from "./access-context";
import { getDb, getSqlite, schema } from "./db";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";
import { workspaceRole } from "./authorize";
import * as repo from "./repo";

const { grpcDefinitions } = schema;

const files = z
  .record(z.string().min(1).max(256), z.string().max(1_048_576))
  .refine((f) => Object.keys(f).length >= 1, "Add at least one .proto file")
  .refine(
    (f) => Object.keys(f).length <= MAX_PROTO_FILES,
    `At most ${MAX_PROTO_FILES} proto files are allowed`,
  );
const name = z.string().trim().min(1).max(100);
const description = z.string().max(500);

export const definitionCreateSchema = z.object({
  workspaceId: z.string().min(1),
  name,
  description: description.default(""),
  files,
});
export const definitionPatchSchema = z.object({ name, description, files }).partial();

const row = (id: string) => {
  const found = getDb().select().from(grpcDefinitions).where(eq(grpcDefinitions.id, id)).get();
  if (!found) throw notFound("gRPC definition");
  return found;
};

/** Requests (name and id) that reference a definition. */
export function definitionUsers(workspaceId: string, definitionId: string): { id: string; name: string }[] {
  return getSqlite()
    .prepare(
      `SELECT id, name FROM requests
       WHERE workspace_id = ? AND json_extract(settings, '$.grpc.definitionId') = ?
       ORDER BY name`,
    )
    .all(workspaceId, definitionId) as { id: string; name: string }[];
}

function validate(sources: Record<string, string>) {
  try {
    loadProtoRoot(sources);
  } catch (err) {
    if (err instanceof ProtoError) throw new HttpError(400, err.message);
    throw err;
  }
}

function describe(r: typeof grpcDefinitions.$inferSelect, withFiles: boolean) {
  const users = definitionUsers(r.workspaceId, r.id);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    description: r.description,
    revision: r.revision,
    fileCount: Object.keys(r.files).length,
    usedBy: users,
    canEdit: workspaceRole(currentCaller(), r.workspaceId) !== "viewer",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(withFiles ? { files: r.files } : {}),
  };
}

const uniqueName = (err: unknown) => /UNIQUE constraint failed/.test((err as Error).message ?? "");

export function listDefinitions(workspaceId: string) {
  repo.requireWorkspace(workspaceId);
  return getDb()
    .select()
    .from(grpcDefinitions)
    .where(eq(grpcDefinitions.workspaceId, workspaceId))
    .orderBy(asc(grpcDefinitions.name))
    .all()
    .map((r) => describe(r, false));
}

export function getDefinition(id: string) {
  return describe(row(id), true);
}

export function createDefinition(raw: z.input<typeof definitionCreateSchema>) {
  const input = definitionCreateSchema.parse(raw);
  repo.requireWorkspace(input.workspaceId);
  validate(input.files);
  const caller = currentCaller();
  const now = Date.now();
  const id = newId();
  try {
    getDb()
      .insert(grpcDefinitions)
      .values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        files: input.files,
        createdBy: caller?.kind === "user" ? caller.user.id : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    if (uniqueName(err)) throw new HttpError(409, `A definition named "${input.name}" already exists`);
    throw err;
  }
  return getDefinition(id);
}

export function updateDefinition(id: string, raw: z.input<typeof definitionPatchSchema>) {
  const patch = definitionPatchSchema.parse(raw);
  const previous = row(id);
  if (patch.files) validate(patch.files);
  try {
    getDb()
      .update(grpcDefinitions)
      .set({
        ...patch,
        ...(patch.files ? { revision: previous.revision + 1 } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(grpcDefinitions.id, id))
      .run();
  } catch (err) {
    if (uniqueName(err)) throw new HttpError(409, `A definition named "${patch.name}" already exists`);
    throw err;
  }
  return getDefinition(id);
}

/** Deleting a set that requests still use would break them, so it is refused. */
export function deleteDefinition(id: string) {
  const r = row(id);
  const users = definitionUsers(r.workspaceId, id);
  if (users.length) {
    const shown = users.slice(0, 5).map((u) => u.name);
    throw new HttpError(
      409,
      `"${r.name}" is used by ${users.length} ${users.length === 1 ? "request" : "requests"} (${shown.join(", ")}${users.length > 5 ? ", …" : ""}). Switch them to another definition first.`,
    );
  }
  getDb().delete(grpcDefinitions).where(eq(grpcDefinitions.id, id)).run();
  return { ok: true };
}

/** The files of a definition, only if it belongs to this workspace. */
export function definitionFiles(workspaceId: string, definitionId: string): Record<string, string> {
  const found = getDb()
    .select()
    .from(grpcDefinitions)
    .where(and(eq(grpcDefinitions.id, definitionId), eq(grpcDefinitions.workspaceId, workspaceId)))
    .get();
  if (!found) throw new HttpError(404, "The shared gRPC definition was not found in this workspace");
  return found.files;
}
