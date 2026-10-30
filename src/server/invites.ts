import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { currentCaller } from "./access-context";
import { actorId, authorize, requireAdmin, type WorkspaceRole } from "./authorize";
import type { Caller } from "./caller";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import { getUser, prepareUser, insertPreparedUser } from "./users";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const publicInvite = ({ tokenHash: _hash, ...row }: typeof schema.invites.$inferSelect) => row;
function permission(workspaceId: string | null) {
  if (workspaceId) authorize(currentCaller(), workspaceId, "manage");
  else requireAdmin();
}
export function listInvites(workspaceId: string | null) {
  permission(workspaceId);
  const query = getDb().select().from(schema.invites);
  return (workspaceId ? query.where(eq(schema.invites.workspaceId, workspaceId)) : query)
    .orderBy(desc(schema.invites.createdAt))
    .all()
    .map(publicInvite);
}
export function createInvite(input: {
  workspaceId?: string | null;
  role?: WorkspaceRole;
  expiresInHours?: number;
}) {
  const workspaceId = input.workspaceId ?? null;
  permission(workspaceId);
  const createdBy = actorId();
  if (!createdBy) throw new HttpError(409, "Create the administrator account first");
  const token = randomBytes(32).toString("base64url");
  const row = {
    id: newId(),
    tokenHash: digest(token),
    createdBy,
    workspaceId,
    role: workspaceId ? (input.role ?? "viewer") : null,
    expiresAt: Date.now() + (input.expiresInHours ?? 24) * 3600000,
    usedAt: null,
    revokedAt: null,
    createdAt: Date.now(),
  };
  getDb().insert(schema.invites).values(row).run();
  return { ...publicInvite(row), token };
}
export function revokeInvite(id: string) {
  const row = getDb().select().from(schema.invites).where(eq(schema.invites.id, id)).get();
  if (!row) throw new HttpError(404, "Invite not found");
  permission(row.workspaceId);
  getDb().update(schema.invites).set({ revokedAt: Date.now() }).where(eq(schema.invites.id, id)).run();
}
function validInvite(token: string) {
  const row = getDb()
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.tokenHash, digest(token)))
    .get();
  if (!row || row.usedAt !== null || row.revokedAt !== null || row.expiresAt <= Date.now())
    throw new HttpError(410, "Invite is invalid, expired, or already used");
  const user = getUser(row.createdBy);
  if (!user || user.disabled) throw new HttpError(410, "Invite creator is unavailable");
  const creator: Caller = { kind: "user", user, via: "session" };
  if (row.workspaceId) authorize(creator, row.workspaceId, "manage");
  else requireAdmin(creator);
  return row;
}
export async function acceptInvite(
  token: string,
  account: { username: string; displayName?: string; password: string },
) {
  validInvite(token);
  const prepared = await prepareUser({
    username: account.username,
    displayName: account.displayName,
    password: account.password,
    isAdmin: false,
  });
  return getDb().transaction((tx) => {
    const row = validInvite(token);
    const user = insertPreparedUser(prepared);
    if (row.workspaceId && row.role)
      tx.insert(schema.workspaceMembers)
        .values({ workspaceId: row.workspaceId, userId: user.id, role: row.role, createdAt: Date.now() })
        .run();
    tx.update(schema.invites).set({ usedAt: Date.now() }).where(eq(schema.invites.id, row.id)).run();
    return user;
  });
}
