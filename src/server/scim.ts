/**
 * SCIM 2.0 provisioning: persistence for users and groups.
 *
 * The pure parts (schemas, filter grammar, PATCH operations, role mapping) live in
 * src/core/scim; this layer is the database half (see ARCHITECTURE.md). Every answer —
 * including errors — is `application/scim+json`, so this file owns its own response
 * helpers instead of the generic `{ error }` envelope from http.ts.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ZodError, type ZodType } from "zod";
import type { AuditChange, AuditEntityKind } from "@/core/audit";
import type { FilterNode } from "@/core/scim/filter";
import { matchFilter, matchSearch, parseFilter, sortResources } from "@/core/scim/filter";
import { applyOperations, type PatchOperation } from "@/core/scim/patch";
import { roleForGroupName } from "@/core/scim/roles";
import {
  ATTRIBUTE_RE,
  type ListOptions,
  parsePage,
  parseSortOrder,
  ScimError,
  SCIM_CONTENT_TYPE,
  scimErrorBody,
  scimGroupInput,
  scimGroupResource,
  scimListResponse,
  scimPatchInput,
  scimUserInput,
  scimUserResource,
  type ScimRecord,
  type ScimResourceType,
} from "@/core/scim/model";
import { withCaller } from "./access-context";
import { authorizeRest, restPolicy } from "./access-policy";
import { audit, auditDenied, shouldAudit } from "./audit";
import { pruneAuditIfDue } from "./audit-settings";
import { authorize, setMember } from "./authorize";
import type { Caller } from "./caller";
import { callerOf } from "./caller";
import type { ScimGroupRow, UserRow } from "./db/schema";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { readBodyText, withApiVersion } from "./http";
import { isHttpError } from "./errors";
import {
  checkPasswordPolicy,
  getUser,
  hashPassword,
  normalizeUsername,
  revokeUserAccess,
  setDisabled,
} from "./users";

/** The id only exists on the single-resource routes, so the params shape stays open. */
type Ctx = { params: Promise<Record<string, string>> };
type Handler = (req: Request, ctx: Ctx, caller: Caller) => Promise<Response>;

/** Same sentinel as service accounts in src/server/users.ts: no password verifies against it. */
const NO_PASSWORD = "!";

/** A SCIM answer: the content type clients expect, plus the API version header. */
export function scimResponse(status: number, body: unknown): Response {
  return withApiVersion(
    new Response(JSON.stringify(body), { status, headers: { "content-type": SCIM_CONTENT_TYPE } }),
  );
}

export function scimError(status: number, detail: string): Response {
  return scimResponse(status, scimErrorBody(status, detail));
}

/** DELETE answers with no body, only the status. */
function scimNoContent(): Response {
  return withApiVersion(new Response(null, { status: 204, headers: { "content-type": SCIM_CONTENT_TYPE } }));
}

/**
 * The route wrapper for SCIM endpoints: same access-policy lookup, caller resolution and
 * audit behaviour as `route()`, but failures answer in the SCIM error shape, and handlers
 * record their own audit events (so the generic one is skipped).
 */
export function scimRoute(method: string, handler: Handler) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      const pathname = new URL(req.url).pathname;
      const policy = restPolicy(method, pathname);
      if (!policy) throw new ScimError(403, "Route has no access policy");
      const caller = callerOf(req);
      if (!caller) throw new ScimError(401, "Authentication required");
      const audited = shouldAudit(method, policy, pathname);
      if (audited) pruneAuditIfDue();
      try {
        await authorizeRest(caller, req, async () => ({}));
      } catch (error) {
        // Reads are not audited, so a refused read is not recorded either.
        if (audited && isHttpError(error) && error.status === 403)
          withCaller(caller, () => auditDenied(req, policy, error.message));
        throw error;
      }
      return await withCaller(caller, () => handler(req, ctx, caller));
    } catch (error) {
      if (error instanceof ScimError) return scimError(error.status, error.detail);
      if (error instanceof ZodError)
        return scimError(400, `Invalid input: ${error.issues[0]?.message ?? "invalid SCIM resource"}`);
      if (isHttpError(error)) return scimError(error.status, error.message);
      console.error("[postbox] unhandled SCIM API error:", error);
      return scimError(500, "Internal error");
    }
  };
}

/**
 * The workspace a SCIM request acts on: `?workspaceId=`, the request body, or the caller's
 * own workspace. Provisioning always names a workspace because group roles live there.
 */
export function scimWorkspace(req: Request, caller: Caller, bodyWorkspaceId?: string): string {
  const fromQuery = new URL(req.url).searchParams.get("workspaceId");
  const workspaceId = bodyWorkspaceId || fromQuery;
  if (workspaceId) {
    authorize(caller, workspaceId, "manage");
    return workspaceId;
  }
  if (caller.kind === "user") {
    const member = getDb()
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, caller.user.id))
      .get();
    if (member) return member.workspaceId;
  }
  const first = getDb()
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .orderBy(asc(schema.workspaces.createdAt))
    .get();
  if (!first) throw new ScimError(400, "workspaceId is required: no workspace to provision into");
  authorize(caller, first.id, "manage");
  return first.id;
}

/** Record one SCIM mutation. Values shown here are always safe ones. */
function scimAudit(
  action: string,
  entityKind: AuditEntityKind,
  workspaceId: string,
  entityId: string,
  entityName: string | null,
  changes: AuditChange[],
  method: string,
  path: string,
): void {
  audit({ action, entityKind, entityId, entityName, workspaceId, changes, method, path });
}

/** Read a SCIM request body: a JSON object, checked against the resource's shape. */
async function readInput<T>(req: Request, shape: ZodType<T>): Promise<{ input: T; raw: ScimRecord }> {
  let value: unknown;
  try {
    value = JSON.parse(await readBodyText(req));
  } catch {
    throw new ScimError(400, "Body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScimError(400, "Body must be a JSON object");
  return { input: shape.parse(value), raw: value as ScimRecord };
}

const bodyWorkspaceId = (raw: ScimRecord) =>
  typeof raw.workspaceId === "string" ? raw.workspaceId : undefined;

// ------------------------------------------------------------------ users

/** Everything on a record that is not owned by a column of its own. */
const RESERVED = new Set(["schema", "id", "userName", "active", "groups", "meta", "password"]);

function profileOf(record: ScimRecord): ScimRecord {
  const profile: ScimRecord = {};
  for (const [key, value] of Object.entries(record)) if (!RESERVED.has(key)) profile[key] = value;
  return profile;
}

/** SCIM has no display name; `name` is what the account shows in the app. */
function displayNameOf(record: ScimRecord, fallback: string): string {
  const name = (record.name as ScimRecord | undefined) ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return (
    text(name.formatted) ||
    [text(name.givenName), text(name.familyName)].filter(Boolean).join(" ") ||
    fallback
  );
}

function userGroups(userId: string, workspaceId: string) {
  return getDb()
    .select()
    .from(schema.scimGroups)
    .where(and(eq(schema.scimGroups.workspaceId, workspaceId), isNull(schema.scimGroups.deletedAt)))
    .all()
    .filter((group) => group.members.some((member) => member.value === userId))
    .map((group) => ({ value: group.id, display: group.name, type: "group" }));
}

function userResource(row: UserRow, workspaceId?: string): ScimRecord {
  const profile = row.scimProfile ?? {};
  return scimUserResource({
    id: row.id,
    externalId: typeof profile.externalId === "string" ? profile.externalId : null,
    userName: row.username,
    active: !row.disabled,
    profile,
    ...(workspaceId ? { groups: userGroups(row.id, workspaceId) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function requireUser(id: string, workspaceId: string): UserRow {
  const row = getUser(id);
  if (!row) throw new ScimError(404, "User not found");
  if (row.deletedAt !== null) throw new ScimError(410, `User ${id} was permanently deleted`);
  const member = getDb()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, row.id)),
    )
    .get();
  if (!member) throw new ScimError(404, `User ${id} is not a member of this workspace`);
  return row;
}

/** A username taken by another account, or by a tombstone: provisioning cannot reuse it. */
function claimUsername(username: string, exceptId?: string): string {
  const normalized = normalizeUsername(username);
  const existing = getDb()
    .select({ id: schema.users.id, deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(eq(schema.users.username, normalized))
    .get();
  if (existing && existing.id !== exceptId) throw new ScimError(409, `That username is taken: ${normalized}`);
  return normalized;
}

/**
 * Deactivating ends access for good: sessions and API keys are revoked, not merely
 * ignored, so reactivating the account later does not bring old keys back to life.
 */
function applyActive(existing: UserRow, active: boolean): void {
  if (active === !existing.disabled) return;
  setDisabled(existing.id, !active);
  if (!active) revokeUserAccess(existing.id);
}

function saveUser(id: string, changes: Record<string, unknown>): void {
  getDb()
    .update(schema.users)
    .set({ ...changes, updatedAt: Date.now() })
    .where(eq(schema.users.id, id))
    .run();
}

/** The audit changes for one user mutation, naming only fields whose values may be shown. */
function userChanges(
  before: UserRow,
  after: { username: string; displayName: string; active: boolean; profile: ScimRecord },
): AuditChange[] {
  const changed = (field: string, previous: unknown, next: unknown) =>
    JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)
      ? []
      : [{ field, before: previous, after: next }];
  return [
    ...changed("username", before.username, after.username),
    ...changed("display_name", before.displayName, after.displayName),
    ...changed("disabled", before.disabled, !after.active),
    ...(changed("profile", before.scimProfile, after.profile).length
      ? [{ field: "profile", redacted: true }]
      : []),
  ];
}

export async function listScimUsers(req: Request, caller: Caller): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const workspaceId = scimWorkspace(req, caller);
  const query = listQuery(params);
  const memberIds = getDb()
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .all()
    .map((member) => member.userId);
  const rows = memberIds.length
    ? getDb()
        .select()
        .from(schema.users)
        .where(and(inArray(schema.users.id, memberIds), isNull(schema.users.deletedAt)))
        .orderBy(asc(schema.users.createdAt))
        .all()
    : [];
  return scimResponse(
    200,
    listResponse(
      "User",
      rows.map((row) => userResource(row)),
      query,
    ),
  );
}

export async function readScimUser(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const workspaceId = scimWorkspace(req, caller);
  const row = requireUser((await ctx.params).id, workspaceId);
  return scimResponse(200, userResource(row, workspaceId));
}

export async function createScimUser(req: Request, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimUserInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const username = claimUsername(input.userName);
  if (input.password) checkPasswordPolicy(input.password);
  const profile = profileOf(input as ScimRecord);
  const now = Date.now();
  const row: UserRow = {
    id: newId(),
    username,
    displayName: displayNameOf(input as ScimRecord, username),
    passwordHash: input.password ? await hashPassword(input.password) : NO_PASSWORD,
    isAdmin: false,
    disabled: input.active === false,
    isService: false,
    sessionVersion: 1,
    scimProfile: profile,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(schema.users).values(row).run();
  // A provisioned account starts as a viewer of the workspace it was provisioned into;
  // groups give it a role when the group name maps to one.
  setMember(workspaceId, username, "viewer");
  scimAudit(
    "scim.user.create",
    "user",
    workspaceId,
    row.id,
    username,
    [
      { field: "username", after: username },
      { field: "display_name", after: row.displayName },
      { field: "active", after: !row.disabled },
      { field: "role", after: "viewer" },
      ...(input.password ? [{ field: "password", redacted: true }] : []),
    ],
    "POST",
    "/api/scim/Users",
  );
  return scimResponse(201, userResource(getUser(row.id)!, workspaceId));
}

/** PUT is a whole replacement: attributes the body does not carry are gone. */
export async function replaceScimUser(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimUserInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const existing = requireUser((await ctx.params).id, workspaceId);
  const username = claimUsername(input.userName, existing.id);
  const profile = profileOf(input as ScimRecord);
  const active = input.active !== false;
  const displayName = displayNameOf(input as ScimRecord, username);
  applyActive(existing, active);
  saveUser(existing.id, { username, displayName, scimProfile: profile });
  scimAudit(
    "scim.user.replace",
    "user",
    workspaceId,
    existing.id,
    username,
    userChanges(existing, { username, displayName, active, profile }),
    "PUT",
    "/api/scim/Users/[id]",
  );
  return scimResponse(200, userResource(getUser(existing.id)!, workspaceId));
}

export async function patchScimUser(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimPatchInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const existing = requireUser((await ctx.params).id, workspaceId);
  const record = applyOperations(userResource(existing, workspaceId), input.Operations as PatchOperation[]);
  const username = claimUsername(String(record.userName ?? existing.username), existing.id);
  const active = record.active !== false;
  const profile = profileOf(record);
  const displayName = displayNameOf(record, username);
  applyActive(existing, active);
  saveUser(existing.id, { username, displayName, scimProfile: profile });
  scimAudit(
    "scim.user.patch",
    "user",
    workspaceId,
    existing.id,
    username,
    userChanges(existing, { username, displayName, active, profile }),
    "PATCH",
    "/api/scim/Users/[id]",
  );
  return scimResponse(200, userResource(getUser(existing.id)!, workspaceId));
}

/**
 * SCIM DELETE deactivates rather than erases: the account answers 410 afterwards, so the
 * provisioning decision — and the audit trail it produced — outlives the account itself.
 */
export async function deleteScimUser(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const workspaceId = scimWorkspace(req, caller);
  const existing = requireUser((await ctx.params).id, workspaceId);
  setDisabled(existing.id, true);
  revokeUserAccess(existing.id);
  const deletedAt = Date.now();
  saveUser(existing.id, { deletedAt });
  scimAudit(
    "scim.user.delete",
    "user",
    workspaceId,
    existing.id,
    existing.username,
    [{ field: "deleted_at", after: new Date(deletedAt).toISOString() }],
    "DELETE",
    "/api/scim/Users/[id]",
  );
  return scimNoContent();
}

// ------------------------------------------------------------------ groups

function groupResource(row: ScimGroupRow): ScimRecord {
  return scimGroupResource({
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    displayName: row.displayName || row.name,
    members: row.members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function requireGroup(id: string, workspaceId: string): ScimGroupRow {
  const row = getDb().select().from(schema.scimGroups).where(eq(schema.scimGroups.id, id)).get();
  if (!row) throw new ScimError(404, "Group not found");
  if (row.workspaceId !== workspaceId) throw new ScimError(404, `Group ${id} is not in this workspace`);
  if (row.deletedAt !== null) throw new ScimError(410, `Group ${id} was permanently deleted`);
  return row;
}

const memberId = (member: ScimRecord) => String(member.value ?? "");

/** Members must name accounts: a group is only useful for provisioning if its members exist. */
function checkedMembers(members: ScimRecord[]): ScimRecord[] {
  for (const member of members) {
    const id = memberId(member);
    const user = getUser(id);
    if (!user) throw new ScimError(400, `Group member "${id}" is not a known user`);
    if (user.deletedAt !== null) throw new ScimError(410, `Group member "${id}" was permanently deleted`);
  }
  return members;
}

/**
 * Apply a group's role to its members. A group whose name maps to a workspace role
 * (`Owners`, `Editors`, `Viewers`) is that role: adding a member grants it, removing one
 * takes it back. Other group names carry no role and only record membership.
 *
 * `setMember` still protects the workspace: a mapped group cannot demote the only owner,
 * so a `Viewers` group with a sole owner answers 409 rather than leaving the workspace
 * ownerless.
 */
function syncGroupRole(workspaceId: string, name: string, before: ScimRecord[], after: ScimRecord[]): void {
  const role = roleForGroupName(name);
  if (!role) return;
  for (const member of after) {
    const user = getUser(memberId(member))!;
    setMember(workspaceId, user.username, role);
  }
  for (const member of before) {
    if (after.some((m) => memberId(m) === memberId(member))) continue;
    const user = getUser(memberId(member));
    if (!user) continue;
    const current = getDb()
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, user.id),
        ),
      )
      .get();
    if (current?.role === role) setMember(workspaceId, user.username, null);
  }
}

function groupChanges(
  before: ScimGroupRow,
  after: { name: string; displayName: string; externalId?: string | null; members: ScimRecord[] },
): AuditChange[] {
  const changed = (field: string, previous: unknown, next: unknown) =>
    JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)
      ? []
      : [{ field, before: previous, after: next }];
  return [
    ...changed("name", before.name, after.name),
    ...changed("display_name", before.displayName, after.displayName),
    ...changed("external_id", before.externalId, after.externalId),
    ...changed(
      "members",
      before.members,
      after.members.map((m) => memberId(m)),
    ),
    ...(roleForGroupName(before.name)
      ? changed("role", roleForGroupName(before.name), roleForGroupName(after.name))
      : []),
  ];
}

export async function listScimGroups(req: Request, caller: Caller): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const workspaceId = scimWorkspace(req, caller);
  const query = listQuery(params);
  const rows = getDb()
    .select()
    .from(schema.scimGroups)
    .where(and(eq(schema.scimGroups.workspaceId, workspaceId), isNull(schema.scimGroups.deletedAt)))
    .orderBy(asc(schema.scimGroups.createdAt))
    .all();
  return scimResponse(200, listResponse("Group", rows.map(groupResource), query));
}

export async function readScimGroup(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const workspaceId = scimWorkspace(req, caller);
  return scimResponse(200, groupResource(requireGroup((await ctx.params).id, workspaceId)));
}

export async function createScimGroup(req: Request, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimGroupInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const name = input.name.trim();
  const taken = getDb()
    .select({ id: schema.scimGroups.id })
    .from(schema.scimGroups)
    .where(and(eq(schema.scimGroups.workspaceId, workspaceId), eq(schema.scimGroups.name, name)))
    .get();
  if (taken) throw new ScimError(409, `Group ${name} already exists in this workspace`);
  const members = checkedMembers(input.members ?? []);
  const now = Date.now();
  const row: ScimGroupRow = {
    id: newId(),
    workspaceId,
    name,
    displayName: input.displayName?.trim() || name,
    externalId: input.externalId ?? null,
    members,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  getDb().insert(schema.scimGroups).values(row).run();
  syncGroupRole(workspaceId, name, [], members);
  scimAudit(
    "scim.group.create",
    "other",
    workspaceId,
    row.id,
    name,
    [
      { field: "name", after: name },
      { field: "display_name", after: row.displayName },
      { field: "members", after: members.map((m) => memberId(m)) },
      ...(roleForGroupName(name) ? [{ field: "role", after: roleForGroupName(name) }] : []),
    ],
    "POST",
    "/api/scim/Groups",
  );
  return scimResponse(201, groupResource(getGroup(row.id)!));
}

/** PUT is a whole replacement, including the membership that carries a mapped role. */
export async function replaceScimGroup(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimGroupInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const existing = requireGroup((await ctx.params).id, workspaceId);
  const name = input.name.trim();
  const taken = getDb()
    .select({ id: schema.scimGroups.id })
    .from(schema.scimGroups)
    .where(and(eq(schema.scimGroups.workspaceId, workspaceId), eq(schema.scimGroups.name, name)))
    .get();
  if (taken && taken.id !== existing.id)
    throw new ScimError(409, `Group ${name} already exists in this workspace`);
  const members = checkedMembers(input.members ?? []);
  // Sync first: a refused role change must leave the group exactly as it was.
  syncGroupRole(workspaceId, name, existing.members, members);
  saveGroup(existing.id, {
    name,
    displayName: input.displayName?.trim() || name,
    externalId: input.externalId ?? null,
    members,
  });
  scimAudit(
    "scim.group.replace",
    "other",
    workspaceId,
    existing.id,
    name,
    groupChanges(existing, {
      name,
      displayName: input.displayName?.trim() || name,
      externalId: input.externalId,
      members,
    }),
    "PUT",
    "/api/scim/Groups/[id]",
  );
  return scimResponse(200, groupResource(getGroup(existing.id)!));
}

export async function patchScimGroup(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const { input, raw } = await readInput(req, scimPatchInput);
  const workspaceId = scimWorkspace(req, caller, bodyWorkspaceId(raw));
  const existing = requireGroup((await ctx.params).id, workspaceId);
  const record = applyOperations(groupResource(existing), input.Operations as PatchOperation[]);
  const name = typeof record.name === "string" ? record.name.trim() : existing.name;
  const taken = getDb()
    .select({ id: schema.scimGroups.id })
    .from(schema.scimGroups)
    .where(and(eq(schema.scimGroups.workspaceId, workspaceId), eq(schema.scimGroups.name, name)))
    .get();
  if (taken && taken.id !== existing.id)
    throw new ScimError(409, `Group ${name} already exists in this workspace`);
  const members = checkedMembers(
    Array.isArray(record.members) ? (record.members as ScimRecord[]) : existing.members,
  );
  // Sync first: a refused role change (the last owner, for example) must leave the group
  // exactly as it was, so nothing is saved when this throws.
  syncGroupRole(workspaceId, name, existing.members, members);
  const displayName = String(record.displayName ?? name);
  const externalId = typeof record.externalId === "string" ? record.externalId : null;
  saveGroup(existing.id, {
    name,
    displayName,
    externalId,
    members,
  });
  scimAudit(
    "scim.group.patch",
    "other",
    workspaceId,
    existing.id,
    name,
    groupChanges(existing, { name, displayName, externalId, members }),
    "PATCH",
    "/api/scim/Groups/[id]",
  );
  return scimResponse(200, groupResource(getGroup(existing.id)!));
}

/** Deleting a mapped group takes back the roles it granted, then keeps a tombstone. */
export async function deleteScimGroup(req: Request, ctx: Ctx, caller: Caller): Promise<Response> {
  const workspaceId = scimWorkspace(req, caller);
  const existing = requireGroup((await ctx.params).id, workspaceId);
  syncGroupRole(workspaceId, existing.name, existing.members, []);
  const deletedAt = Date.now();
  saveGroup(existing.id, { deletedAt });
  scimAudit(
    "scim.group.delete",
    "other",
    workspaceId,
    existing.id,
    existing.name,
    [{ field: "deleted_at", after: new Date(deletedAt).toISOString() }],
    "DELETE",
    "/api/scim/Groups/[id]",
  );
  return scimNoContent();
}

// ------------------------------------------------------------------ list plumbing

interface Query extends ListOptions {
  node?: FilterNode;
}

/** A `search` that looks like a filter is read as one; a bare word matches any searchable text. */
function listQuery(params: URLSearchParams): Query {
  const filter = params.get("filter") ?? undefined;
  const search = params.get("search") ?? undefined;
  const sortBy = params.get("sortBy") ?? undefined;
  if (sortBy && !ATTRIBUTE_RE.test(sortBy)) throw new ScimError(400, `Invalid sortBy "${sortBy}"`);
  const node = filter
    ? parseFilter(filter)
    : search && /\s(eq|co|sw|pr)\s/i.test(search)
      ? parseFilter(search)
      : undefined;
  return { page: parsePage(params), filter, search, sortBy, sortOrder: parseSortOrder(params), node };
}

function matches(record: ScimRecord, query: Query): boolean {
  if (query.node) return matchFilter(query.node, record);
  if (query.search) return matchSearch(record, query.search);
  return true;
}

function listResponse(type: ScimResourceType, resources: ScimRecord[], query: Query): ScimRecord {
  const matched = resources.filter((record) => matches(record, query));
  const sorted = query.sortBy ? sortResources(matched, query.sortBy, query.sortOrder ?? "asc") : matched;
  const from = query.page.startIndex - 1;
  const page = sorted.slice(from, from + query.page.count);
  return scimListResponse(type, page, sorted.length, query);
}

const getGroup = (id: string) =>
  getDb().select().from(schema.scimGroups).where(eq(schema.scimGroups.id, id)).get();

function saveGroup(id: string, changes: Record<string, unknown>): void {
  getDb()
    .update(schema.scimGroups)
    .set({ ...changes, updatedAt: Date.now() })
    .where(eq(schema.scimGroups.id, id))
    .run();
}
