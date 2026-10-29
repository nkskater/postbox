/**
 * Repository layer: maps SQLite rows to core domain types and back.
 * All functions are synchronous (better-sqlite3).
 */
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type {
  CookieInfo,
  Environment,
  FolderDef,
  FolderNode,
  RequestDef,
  TreeNode,
  Variable,
} from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { getDb, schema } from "./db";
import type { FolderRow, RequestRow } from "./db/schema";
import { defaultFolder, defaultRequest, newId } from "./defaults";

const { workspaces, folders, requests, environments, variables, history, cookies } = schema;
const now = () => Date.now();

// ------------------------------------------------------------------ mapping

export function rowToFolder(r: FolderRow): FolderDef & { parentId: string | null; sort: number } {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    auth: r.auth,
    headers: r.headers,
    preRequestScript: r.preRequestScript,
    testScript: r.testScript,
    parentId: r.parentId,
    sort: r.sort,
  };
}

export function rowToRequest(r: RequestRow): RequestDef & { folderId: string; sort: number } {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    url: r.url,
    params: r.params,
    headers: r.headers,
    body: r.body,
    auth: r.auth,
    preRequestScript: r.preRequestScript,
    testScript: r.testScript,
    settings: { ...DEFAULT_SETTINGS, ...r.settings },
    description: r.description,
    examples: r.examples,
    folderId: r.folderId,
    sort: r.sort,
  };
}

// ------------------------------------------------------------------ workspaces

export function listWorkspaces() {
  return getDb().select().from(workspaces).orderBy(asc(workspaces.createdAt)).all();
}

export function getWorkspace(id: string) {
  return getDb().select().from(workspaces).where(eq(workspaces.id, id)).get();
}

export function createWorkspace(name: string) {
  const row = { id: newId(), name, createdAt: now(), updatedAt: now() };
  getDb().insert(workspaces).values(row).run();
  return row;
}

export function renameWorkspace(id: string, name: string) {
  getDb().update(workspaces).set({ name, updatedAt: now() }).where(eq(workspaces.id, id)).run();
}

export function deleteWorkspace(id: string) {
  getDb().delete(workspaces).where(eq(workspaces.id, id)).run();
}

/** Make sure at least one workspace exists (first launch). */
export function ensureDefaultWorkspace() {
  const list = listWorkspaces();
  if (list.length) return list;
  const ws = createWorkspace("My Workspace");
  return [ws];
}

// ------------------------------------------------------------------ tree

export interface TreeFolderSummary {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
}
export interface TreeRequestSummary {
  id: string;
  folderId: string;
  name: string;
  method: string;
  sort: number;
}

/** Lightweight listing for the sidebar. */
export function getTreeSummary(workspaceId: string) {
  const db = getDb();
  const f = db
    .select({ id: folders.id, parentId: folders.parentId, name: folders.name, sort: folders.sort })
    .from(folders)
    .where(eq(folders.workspaceId, workspaceId))
    .orderBy(asc(folders.sort), asc(folders.createdAt))
    .all();
  const r = db
    .select({
      id: requests.id,
      folderId: requests.folderId,
      name: requests.name,
      method: requests.method,
      sort: requests.sort,
    })
    .from(requests)
    .where(eq(requests.workspaceId, workspaceId))
    .orderBy(asc(requests.sort), asc(requests.createdAt))
    .all();
  return { folders: f as TreeFolderSummary[], requests: r as TreeRequestSummary[] };
}

/** Full in-memory tree of a folder (for runner / export). */
export function getFolderTree(folderId: string): FolderNode | null {
  const db = getDb();
  const root = db.select().from(folders).where(eq(folders.id, folderId)).get();
  if (!root) return null;
  const allFolders = db.select().from(folders).where(eq(folders.workspaceId, root.workspaceId)).all();
  const allRequests = db.select().from(requests).where(eq(requests.workspaceId, root.workspaceId)).all();
  const build = (f: FolderRow): FolderNode => {
    const subFolders = allFolders.filter((x) => x.parentId === f.id);
    const reqs = allRequests.filter((x) => x.folderId === f.id);
    const children: (TreeNode & { sort: number })[] = [
      ...subFolders.map((x) => ({ ...build(x), sort: x.sort })),
      ...reqs.map((x) => ({ ...rowToRequest(x), kind: "request" as const })),
    ];
    children.sort((a, b) => a.sort - b.sort);
    const { parentId: _p, sort: _s, ...def } = rowToFolder(f);
    return { ...def, kind: "folder", children };
  };
  return build(root);
}

/** Ancestors of a folder, collection first, including the folder itself. */
export function getFolderChain(
  folderId: string,
): (FolderDef & { parentId: string | null; workspaceId: string })[] {
  const db = getDb();
  const chain: (FolderDef & { parentId: string | null; workspaceId: string })[] = [];
  let id: string | null = folderId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = db.select().from(folders).where(eq(folders.id, id)).get();
    if (!row) break;
    chain.unshift({ ...rowToFolder(row), workspaceId: row.workspaceId });
    id = row.parentId;
  }
  return chain;
}

// ------------------------------------------------------------------ folders

export function getFolder(id: string) {
  const row = getDb().select().from(folders).where(eq(folders.id, id)).get();
  return row ? { ...rowToFolder(row), workspaceId: row.workspaceId } : null;
}

function nextSort(workspaceId: string, parentId: string | null): number {
  const db = getDb();
  const f = db
    .select({ sort: folders.sort })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, workspaceId),
        parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
      ),
    )
    .all();
  const r = parentId
    ? db.select({ sort: requests.sort }).from(requests).where(eq(requests.folderId, parentId)).all()
    : [];
  return Math.max(-1, ...f.map((x) => x.sort), ...r.map((x) => x.sort)) + 1;
}

export function createFolder(workspaceId: string, parentId: string | null, partial: Partial<FolderDef> = {}) {
  const def = defaultFolder({ name: parentId ? "New Folder" : "New Collection", ...partial });
  getDb()
    .insert(folders)
    .values({
      id: def.id,
      workspaceId,
      parentId,
      name: def.name,
      sort: nextSort(workspaceId, parentId),
      description: def.description ?? "",
      auth: def.auth,
      headers: def.headers,
      preRequestScript: def.preRequestScript,
      testScript: def.testScript,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return getFolder(def.id)!;
}

export function updateFolder(id: string, patch: Partial<FolderDef>) {
  const { id: _id, ...rest } = patch;
  getDb()
    .update(folders)
    .set({ ...rest, updatedAt: now() })
    .where(eq(folders.id, id))
    .run();
  return getFolder(id);
}

/** Delete a folder and everything below it (requests cascade via FK). */
export function deleteFolder(id: string) {
  const db = getDb();
  const row = db.select().from(folders).where(eq(folders.id, id)).get();
  if (!row) return;
  const all = db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.workspaceId, row.workspaceId))
    .all();
  const toDelete = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of all)
      if (f.parentId && toDelete.has(f.parentId) && !toDelete.has(f.id)) {
        toDelete.add(f.id);
        grew = true;
      }
  }
  const ids = [...toDelete];
  db.transaction((tx) => {
    tx.delete(requests).where(inArray(requests.folderId, ids)).run();
    tx.delete(variables)
      .where(and(eq(variables.scope, "collection"), inArray(variables.ownerId, ids)))
      .run();
    tx.delete(folders).where(inArray(folders.id, ids)).run();
  });
}

// ------------------------------------------------------------------ requests

export function getRequest(id: string) {
  const row = getDb().select().from(requests).where(eq(requests.id, id)).get();
  return row ? { ...rowToRequest(row), workspaceId: row.workspaceId } : null;
}

export function createRequest(workspaceId: string, folderId: string, partial: Partial<RequestDef> = {}) {
  const def = defaultRequest(partial);
  getDb()
    .insert(requests)
    .values({
      id: def.id,
      workspaceId,
      folderId,
      name: def.name,
      sort: nextSort(workspaceId, folderId),
      method: def.method,
      url: def.url,
      params: def.params,
      headers: def.headers,
      body: def.body,
      auth: def.auth,
      preRequestScript: def.preRequestScript,
      testScript: def.testScript,
      settings: def.settings,
      examples: def.examples ?? [],
      description: def.description ?? "",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return getRequest(def.id)!;
}

export function updateRequest(id: string, patch: Partial<RequestDef>) {
  const { id: _id, ...rest } = patch;
  getDb()
    .update(requests)
    .set({ ...rest, updatedAt: now() })
    .where(eq(requests.id, id))
    .run();
  return getRequest(id);
}

export function deleteRequest(id: string) {
  getDb().delete(requests).where(eq(requests.id, id)).run();
}

export function duplicateRequest(id: string) {
  const r = getRequest(id);
  if (!r) return null;
  const { id: _id, folderId, workspaceId, sort, ...rest } = r;
  const copy = createRequest(workspaceId, folderId, { ...rest, name: `${r.name} Copy` });
  reorder("request", copy.id, folderId, sort + 1);
  return getRequest(copy.id);
}

/** Recursively copy a folder (with requests and collection variables). */
export function duplicateFolder(id: string, targetParent?: string | null, rename = true) {
  const src = getFolder(id);
  if (!src) return null;
  const db = getDb();
  const parentId = targetParent === undefined ? src.parentId : targetParent;
  const { id: _id, parentId: _p, sort, workspaceId, ...def } = src;
  const copy = createFolder(workspaceId, parentId, { ...def, name: rename ? `${src.name} Copy` : src.name });
  if (rename) reorder("folder", copy.id, parentId, sort + 1);
  for (const r of db
    .select()
    .from(requests)
    .where(eq(requests.folderId, id))
    .orderBy(asc(requests.sort))
    .all()) {
    const { id: _rid, folderId: _f, sort: _s, ...rdef } = rowToRequest(r);
    createRequest(workspaceId, copy.id, rdef);
  }
  for (const f of db
    .select()
    .from(folders)
    .where(eq(folders.parentId, id))
    .orderBy(asc(folders.sort))
    .all()) {
    duplicateFolder(f.id, copy.id, false);
  }
  if (!src.parentId) {
    const vars = listVariables(workspaceId, "collection", id);
    replaceVariables(workspaceId, "collection", copy.id, vars);
  }
  return copy;
}

/**
 * Move a folder or request into `parentId` at position `index` (among its siblings),
 * renumbering sort values. Prevents moving a folder into its own subtree.
 */
export function reorder(kind: "folder" | "request", id: string, parentId: string | null, index: number) {
  const db = getDb();
  const item =
    kind === "folder"
      ? db.select().from(folders).where(eq(folders.id, id)).get()
      : db.select().from(requests).where(eq(requests.id, id)).get();
  if (!item) throw new Error("Item not found");
  if (kind === "request" && !parentId) throw new Error("Requests must live inside a collection or folder");
  if (kind === "folder" && parentId) {
    if (getFolderChain(parentId).some((f) => f.id === id))
      throw new Error("Cannot move a folder into itself");
  }
  const workspaceId = item.workspaceId;
  const siblingsF = db
    .select({ id: folders.id, sort: folders.sort })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, workspaceId),
        parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
      ),
    )
    .all()
    .map((x) => ({ ...x, kind: "folder" as const }));
  const siblingsR = parentId
    ? db
        .select({ id: requests.id, sort: requests.sort })
        .from(requests)
        .where(eq(requests.folderId, parentId))
        .all()
        .map((x) => ({ ...x, kind: "request" as const }))
    : [];
  const siblings = [...siblingsF, ...siblingsR]
    .filter((s) => !(s.id === id && s.kind === kind))
    .sort((a, b) => a.sort - b.sort);
  const pos = Math.max(0, Math.min(index, siblings.length));
  siblings.splice(pos, 0, { id, sort: 0, kind });
  db.transaction((tx) => {
    siblings.forEach((s, i) => {
      if (s.kind === "folder") {
        tx.update(folders)
          .set(s.id === id ? { sort: i, parentId, updatedAt: now() } : { sort: i })
          .where(eq(folders.id, s.id))
          .run();
      } else {
        tx.update(requests)
          .set(s.id === id ? { sort: i, folderId: parentId!, updatedAt: now() } : { sort: i })
          .where(eq(requests.id, s.id))
          .run();
      }
    });
  });
}

// ------------------------------------------------------------------ environments & variables

export function listEnvironments(workspaceId: string) {
  return getDb()
    .select()
    .from(environments)
    .where(eq(environments.workspaceId, workspaceId))
    .orderBy(asc(environments.sort), asc(environments.createdAt))
    .all();
}

export function getEnvironment(id: string): (Environment & { workspaceId: string }) | null {
  const row = getDb().select().from(environments).where(eq(environments.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
    variables: listVariables(row.workspaceId, "environment", row.id),
  };
}

export function createEnvironment(workspaceId: string, name: string, vars: Variable[] = []) {
  const id = newId();
  getDb()
    .insert(environments)
    .values({
      id,
      workspaceId,
      name,
      sort: listEnvironments(workspaceId).length,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  if (vars.length) replaceVariables(workspaceId, "environment", id, vars);
  return getEnvironment(id)!;
}

export function renameEnvironment(id: string, name: string) {
  getDb().update(environments).set({ name, updatedAt: now() }).where(eq(environments.id, id)).run();
}

export function deleteEnvironment(id: string) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(variables)
      .where(and(eq(variables.scope, "environment"), eq(variables.ownerId, id)))
      .run();
    tx.delete(environments).where(eq(environments.id, id)).run();
  });
}

export type VariableScopeName = "global" | "collection" | "environment";

export function listVariables(
  workspaceId: string,
  scope: VariableScopeName,
  ownerId: string | null,
): Variable[] {
  return getDb()
    .select()
    .from(variables)
    .where(
      and(
        eq(variables.workspaceId, workspaceId),
        eq(variables.scope, scope),
        ownerId ? eq(variables.ownerId, ownerId) : isNull(variables.ownerId),
      ),
    )
    .orderBy(asc(variables.sort))
    .all()
    .map((v) => ({ id: v.id, key: v.key, value: v.value, type: v.type, enabled: v.enabled }));
}

/** Replace the full variable list of one scope/owner (used by the variable editor). */
export function replaceVariables(
  workspaceId: string,
  scope: VariableScopeName,
  ownerId: string | null,
  list: Variable[],
) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(variables)
      .where(
        and(
          eq(variables.workspaceId, workspaceId),
          eq(variables.scope, scope),
          ownerId ? eq(variables.ownerId, ownerId) : isNull(variables.ownerId),
        ),
      )
      .run();
    list
      .filter((v) => v.key)
      .forEach((v, i) =>
        tx
          .insert(variables)
          .values({
            id: newId(),
            workspaceId,
            scope,
            ownerId,
            key: v.key,
            value: v.value ?? "",
            type: v.type === "secret" ? "secret" : "default",
            enabled: v.enabled !== false,
            sort: i,
          })
          .run(),
      );
  });
}

/**
 * Apply the changes a script made to a scope (record before → after), keeping
 * existing variable types, order and disabled entries.
 */
export function persistScopeDiff(
  workspaceId: string,
  scope: VariableScopeName,
  ownerId: string | null,
  before: Record<string, string>,
  after: Record<string, string>,
) {
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
  const removed = Object.keys(before).filter((k) => !(k in after));
  if (!changed.length && !removed.length) return false;
  const current = listVariables(workspaceId, scope, ownerId);
  const next = current.filter((v) => !(removed.includes(v.key) && v.enabled));
  for (const key of changed) {
    const existing = next.find((v) => v.key === key && v.enabled) ?? next.find((v) => v.key === key);
    if (existing) {
      existing.value = after[key];
      existing.enabled = true;
    } else next.push({ key, value: after[key], type: "default", enabled: true });
  }
  replaceVariables(workspaceId, scope, ownerId, next);
  return true;
}

// ------------------------------------------------------------------ history

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT) || 500;

export function addHistory(entry: Omit<typeof history.$inferInsert, "id" | "createdAt">) {
  const db = getDb();
  const id = newId();
  db.insert(history)
    .values({ ...entry, id, createdAt: now() })
    .run();
  // Trim old entries.
  const cutoff = db
    .select({ createdAt: history.createdAt })
    .from(history)
    .where(eq(history.workspaceId, entry.workspaceId))
    .orderBy(desc(history.createdAt))
    .limit(1)
    .offset(HISTORY_LIMIT)
    .get();
  if (cutoff)
    db.delete(history)
      .where(and(eq(history.workspaceId, entry.workspaceId), lt(history.createdAt, cutoff.createdAt + 1)))
      .run();
  return id;
}

export function listHistory(workspaceId: string, limit = 200) {
  return getDb()
    .select({
      id: history.id,
      requestId: history.requestId,
      method: history.method,
      url: history.url,
      status: history.status,
      timeMs: history.timeMs,
      size: history.size,
      createdAt: history.createdAt,
    })
    .from(history)
    .where(eq(history.workspaceId, workspaceId))
    .orderBy(desc(history.createdAt))
    .limit(limit)
    .all();
}

export function getHistory(id: string) {
  return getDb().select().from(history).where(eq(history.id, id)).get();
}

export function clearHistory(workspaceId: string) {
  getDb().delete(history).where(eq(history.workspaceId, workspaceId)).run();
}

// ------------------------------------------------------------------ cookies

export function listCookies(workspaceId: string): (CookieInfo & { id: string })[] {
  return getDb()
    .select()
    .from(cookies)
    .where(eq(cookies.workspaceId, workspaceId))
    .orderBy(asc(cookies.domain), asc(cookies.name))
    .all()
    .map((c) => ({
      id: c.id,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      hostOnly: c.hostOnly,
    }));
}

/** Replace the workspace jar with the given list (after a request mutated it). */
export function saveCookies(workspaceId: string, list: CookieInfo[]) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(cookies).where(eq(cookies.workspaceId, workspaceId)).run();
    const seen = new Set<string>();
    for (const c of list) {
      const k = `${c.domain}|${c.path}|${c.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      tx.insert(cookies)
        .values({
          id: newId(),
          workspaceId,
          domain: c.domain,
          path: c.path || "/",
          name: c.name,
          value: c.value,
          expires: c.expires ?? null,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite ?? null,
          hostOnly: c.hostOnly ?? true,
          createdAt: now(),
        })
        .run();
    }
  });
}

export function deleteCookie(id: string) {
  getDb().delete(cookies).where(eq(cookies.id, id)).run();
}

export function clearCookies(workspaceId: string) {
  getDb().delete(cookies).where(eq(cookies.workspaceId, workspaceId)).run();
}
