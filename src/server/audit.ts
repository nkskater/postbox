/**
 * Audit trail: who changed what, when. Recorded in one place for every mutating REST call and MCP
 * tool (route wrapper and MCP route), plus explicit entries where the generic view is too coarse
 * (member roles, accounts, keys, restore). Failures to record never fail the request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  actionOf,
  describeChange,
  entityKindOf,
  type AuditChange,
  type AuditEntityKind,
  type AuditRow,
} from "@/core/audit";
import { RESOURCE_TABLES, resourceWorkspace, type ResourceKind } from "./resources";
import { currentCaller } from "./access-context";
import type { Caller } from "./caller";
import { getDb, getSqlite, schema } from "./db";
import { newId } from "./defaults";

const { auditEvents } = schema;
const DAY_MS = 86_400_000;
const MAX_CHANGES = 40;

export interface AuditInput {
  action: string;
  entityKind: AuditEntityKind;
  entityId?: string | null;
  entityName?: string | null;
  workspaceId?: string | null;
  changes?: AuditChange[];
  meta?: Record<string, unknown>;
  result?: "ok" | "denied";
  method?: string;
  path?: string;
  /** Use when there is no current caller (login, sign-up). */
  actor?: { id?: string | null; name: string; kind: "user" | "service" | "env" | "open" | "system" };
  via?: string;
}

/** Tracks whether a request already recorded its own, more detailed event. */
const scopes = new AsyncLocalStorage<{ explicit: boolean }>();
export function withAuditScope<T>(work: (scope: { explicit: boolean }) => T): T {
  const scope = { explicit: false };
  return scopes.run(scope, () => work(scope));
}

export function actorOf(caller: Caller | undefined | null): NonNullable<AuditInput["actor"]> & {
  via?: string;
  keyId?: string;
} {
  if (caller?.kind === "user")
    return {
      id: caller.user.id,
      name: caller.user.username,
      kind: caller.user.isService ? "service" : "user",
      via: caller.via,
      keyId: caller.token?.id,
    };
  if (caller?.kind === "env") return { name: "environment credentials", kind: "env", via: "env" };
  if (caller?.kind === "open") return { name: "anonymous (authentication off)", kind: "open" };
  return { name: "system", kind: "system" };
}

/** Record an event as the current caller. Never throws. */
export function audit(input: AuditInput): void {
  try {
    const at = Date.now();
    const caller = currentCaller();
    const actor = input.actor ?? actorOf(caller);
    const via = input.via ?? (actor as { via?: string }).via ?? null;
    const keyId = (actor as { keyId?: string }).keyId ?? null;
    const db = getDb();
    const revision =
      input.entityId == null
        ? 1
        : db
            .select({ n: count() })
            .from(auditEvents)
            .where(
              and(eq(auditEvents.entityKind, input.entityKind), eq(auditEvents.entityId, input.entityId)),
            )
            .get()!.n + 1;
    db.insert(auditEvents)
      .values({
        id: newId(),
        at,
        actorId: actor.id ?? null,
        actorName: actor.name,
        actorKind: actor.kind,
        via,
        keyId,
        workspaceId: input.workspaceId ?? null,
        action: input.action,
        entityKind: input.entityKind,
        entityId: input.entityId ?? null,
        entityName: input.entityName ?? null,
        revision,
        result: input.result ?? "ok",
        method: input.method ?? null,
        path: input.path ?? null,
        changes: (input.changes ?? []).slice(0, MAX_CHANGES),
        meta: input.meta ?? {},
      })
      .run();
    const scope = scopes.getStore();
    if (scope && !input.result) scope.explicit = true;
  } catch (error) {
    console.error("[postbox] could not record audit event:", error);
  }
}

/** Remove events older than the retention setting (0 keeps everything). Returns how many were removed. */
export function pruneAudit(days: number, at = Date.now()): number {
  if (!days) return 0;
  return getDb()
    .delete(auditEvents)
    .where(lt(auditEvents.at, at - days * DAY_MS))
    .run().changes;
}

export interface AuditFilter {
  /** Restrict to one workspace. Omit for every workspace (administrators). */
  workspaceId?: string;
  actor?: string;
  /** Matches the action exactly, or as a dotted prefix (`request` matches `request.update`). */
  action?: string;
  entityKind?: string;
  entityId?: string;
  result?: string;
  from?: number;
  to?: number;
  /** Free text over actor, action, entity name and id. */
  q?: string;
  limit?: number;
  /** Continue after this event (the last one of the previous page). */
  cursor?: { at: number; id: string };
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

export function queryAudit(filter: AuditFilter): { events: AuditEvent[]; next: string | null } {
  const conditions: (SQL | undefined)[] = [];
  if (filter.workspaceId) conditions.push(eq(auditEvents.workspaceId, filter.workspaceId));
  if (filter.actor) conditions.push(eq(auditEvents.actorName, filter.actor.toLowerCase()));
  if (filter.action)
    conditions.push(
      or(
        eq(auditEvents.action, filter.action),
        sql`${auditEvents.action} LIKE ${escapeLike(filter.action) + ".%"} ESCAPE '\\'`,
      ),
    );
  if (filter.entityKind) conditions.push(eq(auditEvents.entityKind, filter.entityKind));
  if (filter.entityId) conditions.push(eq(auditEvents.entityId, filter.entityId));
  if (filter.result) conditions.push(eq(auditEvents.result, filter.result));
  if (filter.from !== undefined) conditions.push(gte(auditEvents.at, filter.from));
  if (filter.to !== undefined) conditions.push(lte(auditEvents.at, filter.to));
  if (filter.q) {
    const term = `%${escapeLike(filter.q)}%`;
    conditions.push(
      or(
        sql`${auditEvents.actorName} LIKE ${term} ESCAPE '\\'`,
        sql`${auditEvents.action} LIKE ${term} ESCAPE '\\'`,
        sql`${auditEvents.entityName} LIKE ${term} ESCAPE '\\'`,
        sql`${auditEvents.entityId} LIKE ${term} ESCAPE '\\'`,
      ),
    );
  }
  if (filter.cursor)
    conditions.push(
      or(
        lt(auditEvents.at, filter.cursor.at),
        and(eq(auditEvents.at, filter.cursor.at), lt(auditEvents.id, filter.cursor.id)),
      ),
    );
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
  const rows = getDb()
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page,
    next: rows.length > limit && last ? `${last.at}:${last.id}` : null,
  };
}

export type AuditEvent = typeof auditEvents.$inferSelect;
export const toAuditRow = (e: AuditEvent): AuditRow => e;

export function parseCursor(value: string | null): { at: number; id: string } | undefined {
  const match = /^(\d+):(.+)$/.exec(value ?? "");
  return match ? { at: Number(match[1]), id: match[2] } : undefined;
}

// ---------------------------------------------------------------------------------------- generic capture

/** Mutating routes worth a trail: anything that changes content, members, accounts, keys or settings. */
export function shouldAudit(
  method: string,
  policy: { source: string; action?: string; pattern?: string } | null,
  pathname: string,
): boolean {
  if (!policy || ["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (policy.source === "public" || policy.source === "mcp") return false;
  if (policy.source === "admin" || policy.source === "create") return true;
  if (policy.source === "account")
    return ["/api/me/", "/api/settings", "/api/invites"].some((p) => pathname.startsWith(p));
  return policy.action === "write" || policy.action === "manage";
}

export function rowOf(kind: ResourceKind, id: string): Record<string, unknown> | null {
  const row = getSqlite().prepare(`SELECT * FROM ${RESOURCE_TABLES[kind]} WHERE id = ?`).get(id);
  return (row as Record<string, unknown> | undefined) ?? null;
}

const RESOURCE_KINDS = new Set(Object.keys(RESOURCE_TABLES));
const asResourceKind = (kind: AuditEntityKind): ResourceKind | null =>
  RESOURCE_KINDS.has(kind) ? (kind as ResourceKind) : null;

interface RoutePolicy {
  source: string;
  action?: string;
  kind?: ResourceKind;
  pattern?: string;
  id?: string;
}

/** Run a mutating handler and record what it did. */
export async function auditedCall(
  req: Request,
  policy: RoutePolicy,
  run: () => Promise<Response> | Response,
): Promise<Response> {
  const method = req.method;
  const pathname = new URL(req.url).pathname;
  const pattern = policy.pattern ?? pathname;
  const kind = entityKindOf(pattern);
  const resourceKind = policy.kind ?? asResourceKind(kind);
  let before: Record<string, unknown> | null = null;
  let workspaceId: string | null =
    policy.source === "query" ? new URL(req.url).searchParams.get("workspaceId") : null;
  if (policy.source === "resource" && policy.kind && policy.id) {
    try {
      before = rowOf(policy.kind, policy.id);
      workspaceId = before
        ? ((before.workspace_id as string | undefined) ?? (policy.kind === "workspace" ? policy.id : null))
        : null;
    } catch {
      /* the handler will report the missing resource */
    }
  }
  return withAuditScope(async (scope) => {
    const res = await run();
    if (res.status >= 400 || scope.explicit) return res;
    try {
      let entityId = policy.id ?? null;
      let after: Record<string, unknown> | null = null;
      if (method === "POST" && !policy.id && (res.headers.get("content-type") ?? "").includes("json")) {
        const created = (await res
          .clone()
          .json()
          .catch(() => null)) as { id?: unknown } | null;
        if (created && typeof created.id === "string") entityId = created.id;
      }
      if (resourceKind && entityId && method !== "DELETE") after = rowOf(resourceKind, entityId);
      const row = after ?? before;
      workspaceId ??= (row?.workspace_id as string | undefined) ?? (kind === "workspace" ? entityId : null);
      const changes = resourceKind
        ? describeChange(kind, method === "POST" ? null : before, method === "DELETE" ? null : after)
        : [];
      audit({
        action: actionOf(method, pattern),
        entityKind: kind,
        entityId,
        entityName: typeof row?.name === "string" ? row.name : null,
        workspaceId,
        changes,
        method,
        path: pattern,
      });
    } catch (error) {
      console.error("[postbox] could not record audit event:", error);
    }
    return res;
  });
}

/** Record a refused change, so probing and misconfigured automation is visible. */
export function auditDenied(req: Request, policy: RoutePolicy, reason: string) {
  const pattern = policy.pattern ?? new URL(req.url).pathname;
  let workspaceId: string | null = null;
  if (policy.source === "resource" && policy.kind && policy.id) {
    try {
      workspaceId = resourceWorkspace(policy.kind, policy.id);
    } catch {
      /* not found: no workspace */
    }
  }
  audit({
    action: actionOf(req.method, pattern),
    entityKind: entityKindOf(pattern),
    entityId: policy.id ?? null,
    workspaceId,
    result: "denied",
    method: req.method,
    path: pattern,
    meta: { reason },
  });
}
