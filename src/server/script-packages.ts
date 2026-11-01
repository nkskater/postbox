/** Immutable workspace script versions; all code is executed only by the core sandbox. */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import catalog from "@/core/packages/catalog.json";
import {
  PACKAGE_LIMITS,
  packageCreateSchema,
  packageRevisionSchema,
  packagePatchSchema,
  packageContentSchema,
  type ModuleDefinition,
  type ModuleSnapshot,
} from "@/core/packages/model";
import { getDb, schema } from "./db";
import { actorId, authorize, workspaceRole } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError, notFound } from "./errors";
import { newId } from "./defaults";
import * as repo from "./repo";
const { scriptPackages: packages, scriptPackageVersions: versions, requests, folders } = schema;
export const approvedLibraries = () => catalog;
const row = (id: string) => {
  const result = getDb().select().from(packages).where(eq(packages.id, id)).get();
  if (!result) throw notFound("Script package");
  return result;
};
const revision = (id: string, version?: number) => {
  const pkg = row(id);
  const value = getDb()
    .select()
    .from(versions)
    .where(and(eq(versions.packageId, id), eq(versions.version, version ?? pkg.latestVersion)))
    .get();
  if (!value) throw notFound("Package version");
  return { pkg, value };
};
const permissions = (workspaceId: string) => ({
  canEdit: workspaceRole(currentCaller(), workspaceId) !== "viewer",
  canApprove: ["owner"].includes(workspaceRole(currentCaller(), workspaceId) ?? ""),
});
function validateSize(workspaceId: string, source: string) {
  packageContentSchema.parse({ source });
  const usage = getDb()
    .select({
      bytes: sql<number>`coalesce(sum(length(cast(${versions.source} as blob))),0)`,
      count: sql<number>`count(*)`,
    })
    .from(versions)
    .innerJoin(packages, eq(versions.packageId, packages.id))
    .where(eq(packages.workspaceId, workspaceId))
    .get()!;
  if (
    usage.bytes + Buffer.byteLength(source) > PACKAGE_LIMITS.workspaceBytes ||
    usage.count >= PACKAGE_LIMITS.versions
  )
    throw new HttpError(400, "Workspace script packages exceed 2 MiB or 128 immutable versions");
}
function approval(workspaceId: string, approved: boolean) {
  if (approved) authorize(currentCaller(), workspaceId, "manage");
  return approved ? actorId() : null;
}
export function listScriptPackages(workspaceId: string) {
  repo.requireWorkspace(workspaceId);
  return getDb()
    .select()
    .from(packages)
    .where(eq(packages.workspaceId, workspaceId))
    .orderBy(desc(packages.updatedAt))
    .all()
    .map((pkg) => ({ ...pkg, approved: revision(pkg.id).value.approved, ...permissions(workspaceId) }));
}
export function packageReferences(id: string) {
  const pkg = row(id),
    needle = `@team/${pkg.name}`;
  return [
    ...getDb()
      .select({
        id: requests.id,
        name: requests.name,
        pre: requests.preRequestScript,
        post: requests.testScript,
      })
      .from(requests)
      .where(eq(requests.workspaceId, pkg.workspaceId))
      .all()
      .filter((r) => r.pre.includes(needle) || r.post.includes(needle))
      .map((r) => ({ id: r.id, name: r.name, kind: "request" as const })),
    ...getDb()
      .select({ id: folders.id, name: folders.name, pre: folders.preRequestScript, post: folders.testScript })
      .from(folders)
      .where(eq(folders.workspaceId, pkg.workspaceId))
      .all()
      .filter((r) => r.pre.includes(needle) || r.post.includes(needle))
      .map((r) => ({ id: r.id, name: r.name, kind: "folder" as const })),
    ...getDb()
      .select({ id: packages.id, name: packages.name, source: versions.source, version: versions.version })
      .from(versions)
      .innerJoin(packages, eq(versions.packageId, packages.id))
      .where(eq(packages.workspaceId, pkg.workspaceId))
      .all()
      .filter((r) => r.id !== id && r.source.includes(needle))
      .map((r) => ({ id: r.id, name: `${r.name}@${r.version}`, kind: "package" as const })),
  ];
}
export function getScriptPackage(id: string, version?: number) {
  const { pkg, value } = revision(id, version);
  const list = getDb()
    .select({
      version: versions.version,
      hash: versions.hash,
      approved: versions.approved,
      createdAt: versions.createdAt,
      createdBy: versions.createdBy,
      approvedBy: versions.approvedBy,
    })
    .from(versions)
    .where(eq(versions.packageId, id))
    .orderBy(desc(versions.version))
    .all();
  return {
    ...pkg,
    version: value.version,
    source: value.source,
    hash: value.hash,
    approved: value.approved,
    versions: list,
    references: packageReferences(id),
    ...permissions(pkg.workspaceId),
  };
}
export function createScriptPackage(workspaceId: string, raw: z.input<typeof packageCreateSchema>) {
  repo.requireWorkspace(workspaceId);
  const input = packageCreateSchema.parse(raw);
  if (
    getDb()
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.workspaceId, workspaceId), eq(packages.name, input.name)))
      .get()
  )
    throw new HttpError(409, "A package with this name already exists in the workspace");
  const id = newId(),
    now = Date.now();
  getDb().transaction((tx) => {
    validateSize(workspaceId, input.source);
    const approvedBy = approval(workspaceId, input.approved);
    tx.insert(packages)
      .values({
        id,
        workspaceId,
        name: input.name,
        description: input.description,
        latestVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(versions)
      .values({
        packageId: id,
        version: 1,
        source: input.source,
        hash: createHash("sha256").update(input.source).digest("hex"),
        approved: input.approved,
        approvedBy,
        createdBy: actorId(),
        createdAt: now,
      })
      .run();
  });
  return getScriptPackage(id);
}
export function reviseScriptPackage(id: string, raw: z.input<typeof packageRevisionSchema>) {
  const input = packageRevisionSchema.parse(raw);
  getDb().transaction((tx) => {
    const pkg = row(id);
    if (pkg.latestVersion !== input.expectedVersion)
      throw new HttpError(409, "Package changed. Reload before creating a new version.");
    validateSize(pkg.workspaceId, input.source);
    const approvedBy = approval(pkg.workspaceId, input.approved),
      version = pkg.latestVersion + 1;
    tx.insert(versions)
      .values({
        packageId: id,
        version,
        source: input.source,
        hash: createHash("sha256").update(input.source).digest("hex"),
        approved: input.approved,
        approvedBy,
        createdBy: actorId(),
        createdAt: Date.now(),
      })
      .run();
    tx.update(packages)
      .set({ latestVersion: version, updatedAt: Date.now() })
      .where(eq(packages.id, id))
      .run();
  });
  return getScriptPackage(id);
}
export function updateScriptPackage(id: string, raw: z.input<typeof packagePatchSchema>) {
  row(id);
  getDb()
    .update(packages)
    .set({ ...packagePatchSchema.parse(raw), updatedAt: Date.now() })
    .where(eq(packages.id, id))
    .run();
  return getScriptPackage(id);
}
export function approveScriptPackage(id: string, version: number, approved: boolean) {
  const { pkg } = revision(id, version);
  authorize(currentCaller(), pkg.workspaceId, "manage");
  getDb()
    .update(versions)
    .set({ approved, approvedBy: approved ? actorId() : null })
    .where(and(eq(versions.packageId, id), eq(versions.version, version)))
    .run();
  return getScriptPackage(id, version);
}
export function deleteScriptPackage(id: string) {
  const references = packageReferences(id);
  if (references.length)
    throw new HttpError(
      409,
      "Package is referenced by saved collection/request scripts. Remove those imports before deletion; computed imports may not be discoverable.",
    );
  getDb().delete(packages).where(eq(packages.id, id)).run();
  return { ok: true };
}
const cache = new Map<string, Readonly<ModuleDefinition>>();
export function moduleCacheSize() {
  return cache.size;
}
/** Read current approvals on every admission; cached code is keyed by immutable identity and hash. */
export function moduleSnapshot(workspaceId: string): ModuleSnapshot {
  repo.requireWorkspace(workspaceId);
  const definitions = getDb()
    .select({
      id: packages.id,
      name: packages.name,
      latestVersion: packages.latestVersion,
      version: versions.version,
      hash: versions.hash,
      approved: versions.approved,
    })
    .from(versions)
    .innerJoin(packages, eq(versions.packageId, packages.id))
    .where(eq(packages.workspaceId, workspaceId))
    .all();
  const modules: ModuleSnapshot["modules"] = Object.create(null),
    aliases: ModuleSnapshot["aliases"] = Object.create(null);
  let totalBytes = 0;
  for (const item of definitions) {
    if (!item.approved) continue;
    const key = `${workspaceId}:${item.id}:${item.version}:${item.hash}`;
    let definition = cache.get(key);
    if (!definition) {
      const source = revision(item.id, item.version).value.source;
      if (createHash("sha256").update(source).digest("hex") !== item.hash)
        throw new HttpError(500, "Immutable script package integrity check failed");
      definition = Object.freeze({ source, hash: item.hash });
      cache.set(key, definition);
      while (cache.size > PACKAGE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
    }
    totalBytes += Buffer.byteLength(definition.source);
    if (totalBytes > PACKAGE_LIMITS.workspaceBytes || Object.keys(modules).length >= PACKAGE_LIMITS.versions)
      throw new HttpError(400, "Approved package snapshot exceeds workspace execution limits");
    const specifier = `@team/${item.name}@${item.version}`;
    modules[specifier] = definition;
    if (item.version === item.latestVersion) aliases[`@team/${item.name}`] = specifier;
  }
  return { modules, aliases };
}
