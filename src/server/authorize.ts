import { and, asc, eq } from "drizzle-orm";
import type { Caller } from "./caller";
import { scopeAllows, scopeAtLeast, type KeyScope } from "@/core/scopes";
import { callerScope, currentCaller } from "./access-context";
import { getDb, schema } from "./db";
import { HttpError } from "./errors";

export type WorkspaceRole = "owner" | "editor" | "viewer";
export type WorkspaceAction = "read" | "write" | "run" | "manage";
export const ROLE_ACTIONS: Record<WorkspaceRole, readonly WorkspaceAction[]> = {
  viewer: ["read"],
  editor: ["read", "write", "run"],
  owner: ["read", "write", "run", "manage"],
};
export function requireAdmin(caller = currentCaller()) {
  if (caller?.kind === "user" && (!caller.user.isAdmin || caller.user.disabled))
    throw new HttpError(403, "Administrator access required");
  requireScope(caller, "full");
}

/** An API key narrower than `needed` may not do this, whatever its owner could. */
export function requireScope(caller: Caller | null | undefined, needed: KeyScope) {
  if (!scopeAtLeast(callerScope(caller), needed))
    throw new HttpError(
      403,
      `This API key's scope (${callerScope(caller)}) does not allow that; it needs ${needed} access`,
    );
}
export function workspaceRole(caller: Caller | undefined, workspaceId: string): WorkspaceRole | null {
  if (!caller || caller.kind !== "user") return "owner";
  if (caller.user.disabled) return null;
  if (caller.user.isAdmin) return "owner";
  return (
    getDb()
      .select()
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, caller.user.id),
        ),
      )
      .get()?.role ?? null
  );
}
export function authorize(caller: Caller | undefined, workspaceId: string, action: WorkspaceAction) {
  if (
    !getDb()
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get()
  )
    throw new HttpError(404, "Workspace not found");
  const role = workspaceRole(caller, workspaceId);
  if (!role) throw new HttpError(404, "Workspace not found");
  if (!ROLE_ACTIONS[role].includes(action)) throw new HttpError(403, "Insufficient workspace role");
  // The key can narrow what the member may do, never widen it.
  if (!scopeAllows(callerScope(caller), action))
    throw new HttpError(403, `This API key's scope (${callerScope(caller)}) does not allow ${action} access`);
}
export function actorId(): string | null {
  const caller = currentCaller();
  if (caller?.kind === "user") return caller.user.id;
  return (
    getDb()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.isAdmin, true), eq(schema.users.disabled, false)))
      .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
      .get()?.id ?? null
  );
}

export function listMembers(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "manage");
  return getDb()
    .select({
      userId: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      role: schema.workspaceMembers.role,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .all();
}
export function setMember(workspaceId: string, username: string, role: WorkspaceRole | null) {
  authorize(currentCaller(), workspaceId, "manage");
  const db = getDb();
  return db.transaction((tx) => {
    const user = tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username.trim().toLowerCase()))
      .get();
    if (!user) throw new HttpError(404, "User not found");
    const members = tx
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
      .all();
    if (
      members.find((m) => m.userId === user.id)?.role === "owner" &&
      role !== "owner" &&
      members.filter((m) => m.role === "owner").length === 1
    )
      throw new HttpError(409, "A workspace must retain an owner");
    const key = and(
      eq(schema.workspaceMembers.workspaceId, workspaceId),
      eq(schema.workspaceMembers.userId, user.id),
    );
    if (role === null) tx.delete(schema.workspaceMembers).where(key).run();
    else
      tx.insert(schema.workspaceMembers)
        .values({ workspaceId, userId: user.id, role, createdAt: Date.now() })
        .onConflictDoUpdate({
          target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
          set: { role },
        })
        .run();
  });
}
