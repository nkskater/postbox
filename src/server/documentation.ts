import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { generateDocumentation } from "@/core/documentation/generate";
import { publicationInputSchema, type PublicationInput } from "@/core/documentation/model";
import { exportPostmanCollection } from "@/core/convert/postman";
import type { Caller } from "./caller";
import { authorize, workspaceRole } from "./authorize";
import { currentCaller } from "./access-context";
import { getDb, schema } from "./db";
import { HttpError, notFound } from "./errors";
import { audit } from "./audit";
import { assertStorage } from "./usage";
import * as repo from "./repo";
const { documentationPublications: publications } = schema;
function folder(id: string, action: "read" | "manage") {
  const value = repo.getFolder(id);
  if (!value) throw notFound("Collection");
  authorize(currentCaller(), value.workspaceId, action);
  if (value.parentId) throw new HttpError(400, "Documentation belongs to a top-level collection");
  return value;
}
export function previewDocumentation(folderId: string, title?: string) {
  const value = folder(folderId, "read");
  const tree = repo.getFolderTree(folderId)!;
  if (title) tree.name = title;
  const variables = repo.listVariables(value.workspaceId, "collection", folderId);
  const secrets = getDb()
    .select({ value: schema.variables.value })
    .from(schema.variables)
    .where(and(eq(schema.variables.workspaceId, value.workspaceId), eq(schema.variables.type, "secret")))
    .all()
    .map((v) => v.value);
  try {
    return generateDocumentation(tree, variables, secrets);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Documentation generation failed");
  }
}
const existing = (folderId: string) =>
  getDb().select().from(publications).where(eq(publications.folderId, folderId)).get();
const metadata = (row: typeof publications.$inferSelect) => ({
  id: row.id,
  folderId: row.folderId,
  title: row.title,
  visibility: row.visibility,
  revision: row.revision,
  customOrigin: row.customOrigin,
  updatedAt: row.updatedAt,
  path: `/api/documentation/${row.id}`,
});
export function getDocumentation(folderId: string) {
  const value = folder(folderId, "read");
  const saved = existing(folderId);
  return {
    publication: saved?.enabled ? metadata(saved) : null,
    canPublish: workspaceRole(currentCaller(), value.workspaceId) === "owner",
  };
}
export function publishDocumentation(folderId: string, input: PublicationInput) {
  const value = folder(folderId, "manage");
  const parsed = publicationInputSchema.parse(input);
  assertStorage(value.workspaceId);
  const snapshot = previewDocumentation(folderId, parsed.title);
  return getDb().transaction((tx) => {
    const previous = existing(folderId);
    const revision = previous?.enabled ? previous.revision : 0;
    if (parsed.expectedRevision !== revision)
      throw new HttpError(409, "Publication changed. Reload before publishing.");
    if (previous && !previous.enabled) tx.delete(publications).where(eq(publications.id, previous.id)).run();
    const now = Date.now();
    const row = {
      id: previous?.enabled ? previous.id : randomBytes(24).toString("hex"),
      workspaceId: value.workspaceId,
      folderId,
      title: snapshot.root.name,
      snapshot,
      visibility: parsed.visibility,
      enabled: true,
      revision: revision + 1,
      customOrigin: parsed.customOrigin ? new URL(parsed.customOrigin).origin : "",
      createdAt: previous?.enabled ? previous.createdAt : now,
      updatedAt: now,
    };
    if (previous?.enabled) tx.update(publications).set(row).where(eq(publications.id, previous.id)).run();
    else tx.insert(publications).values(row).run();
    audit({
      action: "documentation.publish",
      entityKind: "folder",
      entityId: folderId,
      entityName: value.name,
      workspaceId: value.workspaceId,
      changes: [
        { field: "documentation_visibility", after: row.visibility },
        { field: "documentation_revision", after: row.revision },
      ],
    });
    return metadata(row);
  });
}
export function revokeDocumentation(folderId: string) {
  const value = folder(folderId, "manage");
  getDb().delete(publications).where(eq(publications.folderId, folderId)).run();
  audit({
    action: "documentation.revoke",
    entityKind: "folder",
    entityId: folderId,
    entityName: value.name,
    workspaceId: value.workspaceId,
  });
  return { ok: true };
}
/** The exact public route bypasses the login gate; private snapshots always enforce membership here. */
export function visibleDocumentation(id: string, caller: Caller | null | undefined) {
  const row = getDb().select().from(publications).where(eq(publications.id, id)).get();
  if (!row?.enabled) throw notFound("Documentation");
  if (row.visibility !== "public") {
    if (!caller) throw notFound("Documentation");
    authorize(caller, row.workspaceId, "read");
  }
  return row;
}
export function documentationCollection(id: string, caller: Caller | null | undefined) {
  const row = visibleDocumentation(id, caller);
  return exportPostmanCollection(
    row.snapshot.root,
    row.snapshot.variables.map((v) => ({ ...v, value: "" })),
  );
}
export function importDocumentation(id: string, workspaceId: string) {
  authorize(currentCaller(), workspaceId, "write");
  const row = visibleDocumentation(id, currentCaller());
  return repo.importTree(
    workspaceId,
    structuredClone(row.snapshot.root),
    row.snapshot.variables.map((v) => ({ ...v, value: "" })),
  );
}
