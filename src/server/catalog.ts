import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  catalogPublishSchema,
  catalogMetadataSchema,
  catalogSearchSchema,
  CATALOG_LIMITS,
  type CatalogPublishInput,
  type CatalogMetadataInput,
  type CatalogSearchInput,
} from "@/core/catalog/model";
import { documentationRedactions, generateDocumentation } from "@/core/documentation/generate";
import { redactSensitiveFields } from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";
import { exportPostmanCollection } from "@/core/convert/postman";
import type { Caller } from "./caller";
import { authorize, workspaceRole } from "./authorize";
import { currentCaller } from "./access-context";
import { getDb, schema } from "./db";
import { audit } from "./audit";
import { assertStorage } from "./usage";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";
const { catalogEntries: entries, catalogVersions: versions, workspaceMembers: members } = schema;
type Entry = typeof entries.$inferSelect;
function source(folderId: string, action: "read" | "manage") {
  const folder = repo.getFolder(folderId);
  if (!folder) throw notFound("Collection");
  authorize(currentCaller(), folder.workspaceId, action);
  if (folder.parentId) throw new HttpError(400, "Catalog entries require a top-level collection");
  return folder;
}
const managed = (entry: Entry, caller: Caller | null | undefined) =>
  !!caller && workspaceRole(caller, entry.workspaceId) === "owner";
const visible = (entry: Entry, caller: Caller | null | undefined) =>
  entry.enabled &&
  (entry.visibility === "public" ||
    (!!caller &&
      (managed(entry, caller) ||
        (entry.visibility === "team" && !!workspaceRole(caller, entry.workspaceId)))));
const summary = (entry: Entry, caller: Caller | null | undefined) => ({
  id: entry.id,
  title: entry.title,
  description: entry.description,
  tags: entry.tags,
  owners: entry.owners,
  visibility: entry.visibility,
  latestVersion: entry.latestVersion,
  latestLabel: entry.latestLabel,
  revision: entry.revision,
  updatedAt: entry.updatedAt,
  canManage: managed(entry, caller),
  path: `/api/catalog/${entry.id}?format=html`,
});
const byFolder = (folderId: string) =>
  getDb().select().from(entries).where(eq(entries.folderId, folderId)).get();
function prepare(
  folderId: string,
  input: { title: string; description: string; tags: string[]; owners: string[] },
) {
  const folder = source(folderId, "manage");
  const root = repo.getFolderTree(folderId)!;
  const variables = repo.listVariables(folder.workspaceId, "collection", folderId);
  const secrets = getDb()
    .select({ value: schema.variables.value })
    .from(schema.variables)
    .where(and(eq(schema.variables.workspaceId, folder.workspaceId), eq(schema.variables.type, "secret")))
    .all()
    .map((v) => v.value);
  let redactions: string[];
  try {
    redactions = documentationRedactions(root, variables, secrets);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid catalog source");
  }
  const clean = (text: string, max = 300) =>
    redactStoredValue(redactSensitiveFields(text), redactions).slice(0, max);
  const fields = {
    title: clean(input.title),
    description: clean(input.description, 2000),
    tags: [...new Set(input.tags.filter((tag) => clean(tag) === tag))],
    owners: [...new Set(input.owners.map((value) => clean(value, 100)))],
  };
  root.name = fields.title;
  return { folder, fields, root, variables, secrets };
}
export function getFolderCatalog(folderId: string) {
  const folder = source(folderId, "read");
  const entry = byFolder(folderId);
  const caller = currentCaller();
  return {
    entry: entry && visible(entry, caller) ? summary(entry, caller) : null,
    canPublish: workspaceRole(caller, folder.workspaceId) === "owner",
  };
}
export function publishCatalog(folderId: string, raw: CatalogPublishInput) {
  const input = catalogPublishSchema.parse(raw);
  const { folder, fields, root, variables, secrets } = prepare(folderId, input);
  let snapshot;
  try {
    snapshot = generateDocumentation(root, variables, secrets);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid catalog snapshot");
  }
  assertStorage(folder.workspaceId);
  return getDb().transaction((tx) => {
    const previous = byFolder(folderId);
    const active = previous?.enabled ? previous : undefined;
    if (input.expectedRevision !== (active?.revision ?? 0))
      throw new HttpError(409, "Catalog entry changed. Reload before publishing.");
    if (
      active &&
      tx
        .select()
        .from(versions)
        .where(and(eq(versions.entryId, active.id), eq(versions.label, input.label)))
        .get()
    )
      throw new HttpError(409, "This version label is already published and immutable");
    if (previous && !active) tx.delete(entries).where(eq(entries.id, previous.id)).run();
    const usage = tx
      .select({
        bytes: sql<number>`coalesce(sum(length(cast(${versions.snapshot} as blob))),0)`,
        count: count(),
      })
      .from(versions)
      .innerJoin(entries, eq(entries.id, versions.entryId))
      .where(eq(entries.workspaceId, folder.workspaceId))
      .get()!;
    if (
      usage.count >= CATALOG_LIMITS.versions ||
      usage.bytes + Buffer.byteLength(JSON.stringify(snapshot)) > CATALOG_LIMITS.workspaceBytes
    )
      throw new HttpError(400, "Catalog exceeds 64 retained versions or 16 MiB per workspace");

    const now = Date.now();
    const row = {
      id: active?.id ?? randomBytes(24).toString("hex"),
      workspaceId: folder.workspaceId,
      folderId,
      ...fields,
      visibility: input.visibility,
      enabled: true,
      revision: (active?.revision ?? 0) + 1,
      latestVersion: (active?.latestVersion ?? 0) + 1,
      latestLabel: input.label,
      createdAt: active?.createdAt ?? now,
      updatedAt: now,
    };
    if (active) tx.update(entries).set(row).where(eq(entries.id, row.id)).run();
    else tx.insert(entries).values(row).run();
    tx.insert(versions)
      .values({ entryId: row.id, version: row.latestVersion, label: input.label, snapshot, createdAt: now })
      .run();
    audit({
      action: "catalog.publish",
      entityKind: "folder",
      entityId: folderId,
      workspaceId: folder.workspaceId,
      entityName: folder.name,
      changes: [
        { field: "catalog_visibility", after: row.visibility },
        { field: "catalog_version", after: row.latestVersion },
      ],
    });
    return summary(row, currentCaller());
  });
}
export function updateCatalog(folderId: string, raw: CatalogMetadataInput) {
  const input = catalogMetadataSchema.parse(raw);
  const folder = source(folderId, "manage");
  return getDb().transaction((tx) => {
    const entry = byFolder(folderId);
    if (!entry?.enabled) throw notFound("Catalog entry");
    if (entry.revision !== input.expectedRevision)
      throw new HttpError(409, "Catalog entry changed. Reload before updating.");
    const unchanged =
      input.title === entry.title &&
      input.description === entry.description &&
      JSON.stringify(input.tags) === JSON.stringify(entry.tags) &&
      JSON.stringify(input.owners) === JSON.stringify(entry.owners);
    const fields = unchanged
      ? { title: entry.title, description: entry.description, tags: entry.tags, owners: entry.owners }
      : prepare(folderId, input).fields;
    const row = {
      ...entry,
      ...fields,
      visibility: input.visibility,
      revision: entry.revision + 1,
      updatedAt: Date.now(),
    };
    tx.update(entries).set(row).where(eq(entries.id, entry.id)).run();
    audit({
      action: "catalog.update",
      entityKind: "folder",
      entityId: folderId,
      workspaceId: folder.workspaceId,
      changes: [{ field: "catalog_visibility", after: row.visibility }],
    });
    return summary(row, currentCaller());
  });
}
export function revokeCatalog(folderId: string) {
  const folder = source(folderId, "manage");
  getDb().delete(entries).where(eq(entries.folderId, folderId)).run();
  audit({
    action: "catalog.revoke",
    entityKind: "folder",
    entityId: folderId,
    workspaceId: folder.workspaceId,
  });
  return { ok: true };
}
function visibilityFilter(caller: Caller | null | undefined): SQL {
  if (!caller) return eq(entries.visibility, "public");
  if (caller.kind !== "user" || (caller.user.isAdmin && !caller.user.disabled)) return sql`1=1`;
  if (caller.user.disabled) return eq(entries.visibility, "public");
  const roles = getDb()
    .select({ workspaceId: members.workspaceId, role: members.role })
    .from(members)
    .where(eq(members.userId, caller.user.id))
    .all();
  const team = roles.map((r) => r.workspaceId),
    owner = roles.filter((r) => r.role === "owner").map((r) => r.workspaceId);
  return or(
    eq(entries.visibility, "public"),
    ...(team.length ? [and(eq(entries.visibility, "team"), inArray(entries.workspaceId, team))!] : []),
    ...(owner.length ? [inArray(entries.workspaceId, owner)] : []),
  )!;
}
/** Apply authorization in SQL before matching, counting or pagination; snapshots are never indexed. */
export function searchCatalog(raw: CatalogSearchInput, caller: Caller | null | undefined = currentCaller()) {
  const input = catalogSearchSchema.parse(raw);
  const conditions: SQL[] = [eq(entries.enabled, true), visibilityFilter(caller)];
  const escape = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`);
  if (input.query) {
    const term = `%${escape(input.query.toLowerCase())}%`;
    conditions.push(
      sql`(lower(${entries.title}) like ${term} escape '!' OR lower(${entries.description}) like ${term} escape '!' OR lower(${entries.tags}) like ${term} escape '!' OR lower(${entries.owners}) like ${term} escape '!')`,
    );
  }
  if (input.tag)
    conditions.push(sql`exists (select 1 from json_each(${entries.tags}) where value = ${input.tag})`);
  if (input.visibility) conditions.push(eq(entries.visibility, input.visibility));
  const where = and(...conditions);
  const total = getDb().select({ n: count() }).from(entries).where(where).get()!.n;
  const rows = getDb()
    .select({
      id: entries.id,
      workspaceId: entries.workspaceId,
      folderId: entries.folderId,
      title: entries.title,
      description: entries.description,
      tags: entries.tags,
      owners: entries.owners,
      visibility: entries.visibility,
      enabled: entries.enabled,
      revision: entries.revision,
      latestVersion: entries.latestVersion,
      latestLabel: entries.latestLabel,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(where)
    .orderBy(desc(entries.updatedAt), entries.id)
    .limit(input.limit)
    .offset(input.offset)
    .all();
  return {
    entries: rows.map((row) => summary(row, caller)),
    total,
    limit: input.limit,
    offset: input.offset,
  };
}
export function getCatalogEntry(
  id: string,
  version: number | undefined,
  caller: Caller | null | undefined = currentCaller(),
) {
  const entry = getDb().select().from(entries).where(eq(entries.id, id)).get();
  if (!entry || !visible(entry, caller)) throw notFound("Catalog entry");
  const selected = getDb()
    .select()
    .from(versions)
    .where(and(eq(versions.entryId, id), eq(versions.version, version ?? entry.latestVersion)))
    .get();
  if (!selected) throw notFound("Catalog version");
  const history = getDb()
    .select({ version: versions.version, label: versions.label, createdAt: versions.createdAt })
    .from(versions)
    .where(eq(versions.entryId, id))
    .orderBy(desc(versions.version))
    .all();
  return {
    ...summary(entry, caller),
    version: selected.version,
    label: selected.label,
    snapshot: selected.snapshot,
    versions: history,
  };
}
export function exportCatalog(
  id: string,
  version: number | undefined,
  caller: Caller | null | undefined = currentCaller(),
) {
  const entry = getCatalogEntry(id, version, caller);
  return exportPostmanCollection(
    entry.snapshot.root,
    entry.snapshot.variables.map((v) => ({ ...v, value: "" })),
  );
}
export function importCatalog(id: string, workspaceId: string, version?: number) {
  authorize(currentCaller(), workspaceId, "write");
  const entry = getCatalogEntry(id, version);
  return {
    ...repo.importTree(
      workspaceId,
      structuredClone(entry.snapshot.root),
      entry.snapshot.variables.map((v) => ({ ...v, value: "" })),
    ),
    source: { entryId: id, version: entry.version, label: entry.label },
  };
}
