/**
 * Credential broker. A workspace registers an API (base URL + the vault secret that authenticates it); consumers
 * (people, service accounts, API keys) ask for access, a workspace owner approves it with limits, and the consumer
 * then calls the API *through Postbox*. Postbox injects the credential, so the consumer never holds it.
 *
 * A grant's id is the reference the consumer presents. It only works for the identity it was approved for, so a
 * leaked reference is useless to anyone else; revoking, expiring or disabling the API stops it at once.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { evaluateCall, type GrantStatus } from "@/core/broker/grant";
import {
  attachCredential,
  consumerHeaders,
  redactBytes,
  redactText,
  safeResponseHeaders,
  validHeaderName,
} from "@/core/broker/inject";
import type { Injection } from "@/core/broker/inject";
import {
  METHODS,
  TargetError,
  buildTarget,
  normalizePrefix,
  parseBaseUrl,
  type BrokerMethod,
} from "@/core/broker/target";
import { RequestError, sendRequest } from "@/core/http/engine";
import { HostPolicyError } from "@/core/http/policy";
import { DEFAULT_SETTINGS } from "@/core/types";
import { domainMatches } from "@/core/vault/domains";
import { checkVaultDomains, guardedSecrets } from "@/core/vault/guard";
import { currentCaller } from "./access-context";
import { audit } from "./audit";
import { actorId, workspaceRole } from "./authorize";
import { getPolicy } from "./context";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";
import { loadVaultForExecution } from "./vault";

const { brokerApis, brokerGrants, vaultSecrets, workspaceMembers, users } = schema;

export const MAX_APIS_PER_WORKSPACE = 100;
export const MAX_ACCESS_DAYS = 365;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const CALL_TIMEOUT_MS = 30_000;

const bad = (message: string) => new HttpError(400, message);
const methodList = z.array(z.enum(METHODS)).max(METHODS.length);
const prefixList = z.array(z.string().min(1).max(200)).max(50);

const injectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }).strict(),
  z
    .object({
      type: z.literal("header"),
      name: z.string().refine(validHeaderName, "Not a valid header name"),
      prefix: z.string().max(40).optional(),
    })
    .strict(),
  z.object({ type: z.literal("basic"), username: z.string().max(200) }).strict(),
  z.object({ type: z.literal("query"), name: z.string().min(1).max(100) }).strict(),
]);

export const apiInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, "Use letters, digits, spaces, '_', '.' or '-'"),
    description: z.string().max(500).optional(),
    baseUrl: z.string().min(1).max(2000),
    secretName: z.string().min(1).max(64),
    injection: injectionSchema.default({ type: "bearer" }),
    methods: methodList.optional(),
    pathPrefixes: prefixList.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const apiPatch = apiInput.partial().strict();

export const requestInput = z
  .object({
    reason: z.string().max(500).optional(),
    /** Bind the access to the API key making this request, not just its owner. */
    bindToKey: z.boolean().optional(),
  })
  .strict();

const limits = {
  methods: methodList.optional(),
  pathPrefixes: prefixList.optional(),
  /** Seconds from now; omit for no expiry. */
  expiresInSec: z
    .number()
    .int()
    .min(60)
    .max(MAX_ACCESS_DAYS * 86_400)
    .optional(),
};
export const approveInput = z.object({ ...limits, tokenId: z.string().min(1).optional() }).strict();
export const grantInput = z
  .object({
    ...limits,
    consumerId: z.string().min(1),
    reason: z.string().max(500).optional(),
    tokenId: z.string().min(1).optional(),
  })
  .strict();

type ApiRow = typeof brokerApis.$inferSelect;
type GrantRow = typeof brokerGrants.$inferSelect;

export interface ApiView {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  baseUrl: string;
  secretName: string;
  injection: Injection;
  methods: string[];
  pathPrefixes: string[];
  enabled: boolean;
  /** Whether the vault secret can currently be used by the broker. */
  secretState: "ok" | "missing" | "disabled" | "needs-value";
  createdAt: number;
  updatedAt: number;
}

export interface GrantView {
  id: string;
  workspaceId: string;
  apiId: string;
  apiName: string;
  consumerId: string;
  consumerName: string;
  tokenBound: boolean;
  status: GrantStatus | "expired";
  reason: string;
  methods: string[];
  pathPrefixes: string[];
  decidedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  createdAt: number;
  /** What the consumer passes to the call route. */
  reference: string;
}

/** Who is acting, as a consumer: a user id (service accounts included), "open" or "env"; null for unattended work. */
function consumer(): { id: string; name: string; tokenId: string | null } | null {
  const caller = currentCaller();
  if (caller?.kind === "user")
    return { id: caller.user.id, name: caller.user.username, tokenId: caller.token?.id ?? null };
  if (caller?.kind === "open") return { id: "open", name: "open access", tokenId: null };
  if (caller?.kind === "env") return { id: "env", name: "environment credential", tokenId: null };
  return null;
}

const isManager = (workspaceId: string) => workspaceRole(currentCaller(), workspaceId) === "owner";

function secretRow(workspaceId: string, name: string) {
  return getDb()
    .select()
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.workspaceId, workspaceId),
        eq(vaultSecrets.name, name),
        eq(vaultSecrets.ownerId, ""),
      ),
    )
    .get();
}

function secretState(row: ApiRow): ApiView["secretState"] {
  const s = secretRow(row.workspaceId, row.secretName);
  if (!s) return "missing";
  if (!s.enabled) return "disabled";
  if (!s.ciphertext) return "needs-value";
  return "ok";
}

function apiView(row: ApiRow): ApiView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    baseUrl: row.baseUrl,
    secretName: row.secretName,
    injection: row.injection as unknown as Injection,
    methods: row.methods,
    pathPrefixes: row.pathPrefixes,
    enabled: row.enabled,
    secretState: secretState(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function grantView(row: GrantRow, apiName: string, now = Date.now()): GrantView {
  const expired = row.status === "approved" && row.expiresAt !== null && row.expiresAt <= now;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    apiId: row.apiId,
    apiName,
    consumerId: row.consumerId,
    consumerName: row.consumerName,
    tokenBound: !!row.tokenId,
    status: expired ? "expired" : (row.status as GrantStatus),
    reason: row.reason,
    methods: row.methods,
    pathPrefixes: row.pathPrefixes,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    createdAt: row.createdAt,
    reference: row.id,
  };
}

const apiRow = (id: string) => {
  const row = getDb().select().from(brokerApis).where(eq(brokerApis.id, id)).get();
  if (!row) throw notFound("API");
  return row;
};

const grantRow = (id: string) => {
  const row = getDb().select().from(brokerGrants).where(eq(brokerGrants.id, id)).get();
  if (!row) throw notFound("Access");
  return row;
};

/** A consumer who is not a manager sees only their own grants; everyone else's look like they do not exist. */
const visibleGrant = (row: GrantRow) => {
  if (isManager(row.workspaceId)) return true;
  const me = consumer();
  return !!me && me.id === row.consumerId;
};

// ---------------------------------------------------------------- APIs

/** The secret must be a plain workspace secret: not personal, not limited to collections, and usable for this host. */
function checkSecret(workspaceId: string, secretName: string, baseUrl: URL) {
  const s = secretRow(workspaceId, secretName);
  if (!s) throw bad(`There is no workspace vault secret named "${secretName}"`);
  if (s.collectionIds.length)
    throw bad(
      `The vault secret "${secretName}" is limited to collections; the broker needs a workspace-wide secret`,
    );
  if (s.domains.length && !domainMatches(s.domains, baseUrl.hostname))
    throw bad(
      `The vault secret "${secretName}" may only be sent to ${s.domains.join(", ")}, not ${baseUrl.hostname}`,
    );
}

function parseBase(text: string): URL {
  try {
    return parseBaseUrl(text);
  } catch (error) {
    if (error instanceof TargetError) throw bad(error.message);
    throw error;
  }
}

const cleanPrefixes = (list: string[] | undefined) => [...new Set((list ?? []).map(normalizePrefix))];

export function listApis(workspaceId: string): ApiView[] {
  repo.requireWorkspace(workspaceId);
  return getDb()
    .select()
    .from(brokerApis)
    .where(eq(brokerApis.workspaceId, workspaceId))
    .orderBy(brokerApis.name)
    .all()
    .map(apiView);
}

export const getApi = (id: string) => apiView(apiRow(id));

export function createApi(workspaceId: string, raw: z.input<typeof apiInput>): ApiView {
  repo.requireWorkspace(workspaceId);
  const input = apiInput.parse(raw);
  const db = getDb();
  if (
    db.select().from(brokerApis).where(eq(brokerApis.workspaceId, workspaceId)).all().length >=
    MAX_APIS_PER_WORKSPACE
  )
    throw bad(`A workspace can register at most ${MAX_APIS_PER_WORKSPACE} APIs`);
  if (
    db
      .select()
      .from(brokerApis)
      .where(and(eq(brokerApis.workspaceId, workspaceId), eq(brokerApis.name, input.name)))
      .get()
  )
    throw new HttpError(409, `An API named "${input.name}" already exists`);
  const base = parseBase(input.baseUrl);
  checkSecret(workspaceId, input.secretName, base);
  const now = Date.now();
  const row: ApiRow = {
    id: newId(),
    workspaceId,
    name: input.name,
    description: input.description ?? "",
    baseUrl: base.toString().replace(/\/$/, base.pathname === "/" ? "" : "/"),
    secretName: input.secretName,
    injection: input.injection,
    methods: input.methods ?? [],
    pathPrefixes: cleanPrefixes(input.pathPrefixes),
    enabled: input.enabled ?? true,
    createdBy: actorId(),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(brokerApis).values(row).run();
  audit({
    action: "broker.api.create",
    entityKind: "brokerApi",
    entityId: row.id,
    entityName: row.name,
    workspaceId,
    changes: [],
    meta: { baseUrl: row.baseUrl, secretName: row.secretName, injection: input.injection.type },
  });
  return apiView(row);
}

export function updateApi(id: string, raw: z.input<typeof apiPatch>): ApiView {
  const patch = apiPatch.parse(raw);
  const row = apiRow(id);
  const db = getDb();
  if (patch.name && patch.name !== row.name) {
    if (
      db
        .select()
        .from(brokerApis)
        .where(and(eq(brokerApis.workspaceId, row.workspaceId), eq(brokerApis.name, patch.name)))
        .get()
    )
      throw new HttpError(409, `An API named "${patch.name}" already exists`);
  }
  const baseText = patch.baseUrl ?? row.baseUrl;
  const base = parseBase(baseText);
  const secretName = patch.secretName ?? row.secretName;
  if (patch.baseUrl !== undefined || patch.secretName !== undefined)
    checkSecret(row.workspaceId, secretName, base);
  const next: ApiRow = {
    ...row,
    name: patch.name ?? row.name,
    description: patch.description ?? row.description,
    baseUrl:
      patch.baseUrl !== undefined
        ? base.toString().replace(/\/$/, base.pathname === "/" ? "" : "/")
        : row.baseUrl,
    secretName,
    injection: (patch.injection ?? row.injection) as Record<string, unknown>,
    methods: patch.methods ?? row.methods,
    pathPrefixes: patch.pathPrefixes ? cleanPrefixes(patch.pathPrefixes) : row.pathPrefixes,
    enabled: patch.enabled ?? row.enabled,
    updatedAt: Date.now(),
  };
  db.update(brokerApis).set(next).where(eq(brokerApis.id, id)).run();
  audit({
    action: "broker.api.update",
    entityKind: "brokerApi",
    entityId: id,
    entityName: next.name,
    workspaceId: row.workspaceId,
    changes: [],
    meta: { fields: Object.keys(patch) },
  });
  return apiView(next);
}

export function deleteApi(id: string) {
  const row = apiRow(id);
  getDb().delete(brokerApis).where(eq(brokerApis.id, id)).run();
  audit({
    action: "broker.api.delete",
    entityKind: "brokerApi",
    entityId: id,
    entityName: row.name,
    workspaceId: row.workspaceId,
    changes: [],
  });
}

// ---------------------------------------------------------------- grants

export function listGrants(workspaceId: string, apiId?: string): GrantView[] {
  repo.requireWorkspace(workspaceId);
  const names = new Map(
    getDb()
      .select({ id: brokerApis.id, name: brokerApis.name })
      .from(brokerApis)
      .where(eq(brokerApis.workspaceId, workspaceId))
      .all()
      .map((a) => [a.id, a.name]),
  );
  const now = Date.now();
  return getDb()
    .select()
    .from(brokerGrants)
    .where(eq(brokerGrants.workspaceId, workspaceId))
    .orderBy(desc(brokerGrants.createdAt))
    .all()
    .filter((g) => (!apiId || g.apiId === apiId) && visibleGrant(g))
    .map((g) => grantView(g, names.get(g.apiId) ?? "", now));
}

export const getGrant = (id: string): GrantView => {
  const row = grantRow(id);
  if (!visibleGrant(row)) throw notFound("Access");
  return grantView(row, apiRow(row.apiId).name);
};

function auditGrant(action: string, row: GrantRow, apiName: string, meta: Record<string, unknown> = {}) {
  audit({
    action,
    entityKind: "brokerGrant",
    entityId: row.id,
    entityName: `${row.consumerName} → ${apiName}`,
    workspaceId: row.workspaceId,
    changes: [],
    meta: { apiId: row.apiId, consumerId: row.consumerId, ...meta },
  });
}

const clampLimits = (api: ApiRow, methods?: string[], prefixes?: string[]) => {
  const m = methods ?? [];
  if (api.methods.length && m.some((x) => !api.methods.includes(x)))
    throw bad(`This API only allows ${api.methods.join(", ")}`);
  return { methods: m, pathPrefixes: cleanPrefixes(prefixes) };
};

/** A consumer asks for access; it waits for a workspace owner. */
export function requestAccess(apiId: string, raw: z.input<typeof requestInput>): GrantView {
  const input = requestInput.parse(raw);
  const api = apiRow(apiId);
  const me = consumer();
  if (!me) throw bad("Access can only be requested by a signed-in consumer");
  if (input.bindToKey && !me.tokenId) throw bad("bindToKey needs the request to be made with an API key");
  const db = getDb();
  const live = db
    .select()
    .from(brokerGrants)
    .where(and(eq(brokerGrants.apiId, apiId), eq(brokerGrants.consumerId, me.id)))
    .all()
    .find(
      (g) =>
        g.status === "pending" ||
        (g.status === "approved" && (g.expiresAt === null || g.expiresAt > Date.now())),
    );
  if (live) throw new HttpError(409, `You already have ${live.status} access to "${api.name}"`);
  const now = Date.now();
  const row: GrantRow = {
    id: `brk_${newId()}`,
    workspaceId: api.workspaceId,
    apiId,
    consumerId: me.id,
    consumerName: me.name,
    tokenId: input.bindToKey ? me.tokenId : null,
    status: "pending",
    reason: input.reason ?? "",
    methods: [],
    pathPrefixes: [],
    requestedBy: me.id,
    decidedBy: null,
    decidedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(brokerGrants).values(row).run();
  auditGrant("broker.access.request", row, api.name, { reason: row.reason });
  return grantView(row, api.name);
}

function decide(row: GrantRow, api: ApiRow, status: GrantStatus, set: Partial<GrantRow>): GrantRow {
  const next: GrantRow = {
    ...row,
    ...set,
    status,
    decidedBy: actorId(),
    decidedAt: Date.now(),
    updatedAt: Date.now(),
  };
  getDb().update(brokerGrants).set(next).where(eq(brokerGrants.id, row.id)).run();
  void api;
  return next;
}

export function approveAccess(id: string, raw: z.input<typeof approveInput>): GrantView {
  const input = approveInput.parse(raw);
  const row = grantRow(id);
  const api = apiRow(row.apiId);
  if (row.status !== "pending") throw new HttpError(409, `This request is already ${row.status}`);
  const lim = clampLimits(api, input.methods, input.pathPrefixes);
  const next = decide(row, api, "approved", {
    ...lim,
    tokenId: input.tokenId ?? row.tokenId,
    expiresAt: input.expiresInSec ? Date.now() + input.expiresInSec * 1000 : null,
  });
  auditGrant("broker.access.approve", next, api.name, {
    methods: next.methods,
    pathPrefixes: next.pathPrefixes,
    expiresAt: next.expiresAt,
    keyBound: !!next.tokenId,
  });
  return grantView(next, api.name);
}

export function denyAccess(id: string): GrantView {
  const row = grantRow(id);
  const api = apiRow(row.apiId);
  if (row.status !== "pending") throw new HttpError(409, `This request is already ${row.status}`);
  const next = decide(row, api, "denied", {});
  auditGrant("broker.access.deny", next, api.name);
  return grantView(next, api.name);
}

/** A manager approves access for a consumer directly, without a request. */
export function grantAccess(apiId: string, raw: z.input<typeof grantInput>): GrantView {
  const input = grantInput.parse(raw);
  const api = apiRow(apiId);
  const db = getDb();
  let name = input.consumerId;
  if (input.consumerId === "open" || input.consumerId === "env") {
    if (consumer()?.id !== input.consumerId) throw bad("That consumer is not the current caller");
    name = consumer()!.name;
  } else {
    const user = db.select().from(users).where(eq(users.id, input.consumerId)).get();
    const member = db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, api.workspaceId), eq(workspaceMembers.userId, input.consumerId)),
      )
      .get();
    if (!user || (!member && !user.isAdmin)) throw bad("That user is not a member of this workspace");
    if (user.disabled) throw bad("That account is disabled");
    name = user.username;
  }
  const lim = clampLimits(api, input.methods, input.pathPrefixes);
  const now = Date.now();
  const row: GrantRow = {
    id: `brk_${newId()}`,
    workspaceId: api.workspaceId,
    apiId,
    consumerId: input.consumerId,
    consumerName: name,
    tokenId: input.tokenId ?? null,
    status: "approved",
    reason: input.reason ?? "",
    ...lim,
    requestedBy: null,
    decidedBy: actorId(),
    decidedAt: now,
    expiresAt: input.expiresInSec ? now + input.expiresInSec * 1000 : null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(brokerGrants).values(row).run();
  auditGrant("broker.access.grant", row, api.name, {
    methods: row.methods,
    pathPrefixes: row.pathPrefixes,
    expiresAt: row.expiresAt,
    keyBound: !!row.tokenId,
  });
  return grantView(row, api.name);
}

/** Stops the reference working at once. The consumer it belongs to, or a workspace owner, may do this. */
export function revokeAccess(id: string): GrantView {
  const row = grantRow(id);
  if (!visibleGrant(row)) throw notFound("Access");
  const api = apiRow(row.apiId);
  if (row.status === "revoked" || row.status === "denied")
    throw new HttpError(409, `This access is already ${row.status}`);
  const next = decide(row, api, "revoked", {});
  auditGrant("broker.access.revoke", next, api.name, {
    by: isManager(row.workspaceId) ? "manager" : "consumer",
  });
  return grantView(next, api.name);
}

// ---------------------------------------------------------------- the call

export const callInput = z
  .object({
    method: z.enum(METHODS),
    /** Path (and query) under the API's base URL, starting with "/". */
    path: z.string().min(1).max(4000),
    headers: z.record(z.string(), z.string().max(4000)).optional(),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
  })
  .strict();

export interface CallResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  contentType: string;
  body?: string;
  bodyBase64?: string;
  size: number;
  truncated: boolean;
  /** True when the response contained the credential and it was masked. */
  redacted: boolean;
}

function deny(
  row: GrantRow,
  api: ApiRow,
  status: number,
  code: string,
  reason: string,
  call: { method: string; path: string },
): never {
  audit({
    action: "broker.call",
    entityKind: "brokerGrant",
    entityId: row.id,
    entityName: `${row.consumerName} → ${api.name}`,
    workspaceId: row.workspaceId,
    changes: [],
    result: "denied",
    meta: { apiId: api.id, method: call.method, path: call.path.split("?")[0], code },
  });
  throw new HttpError(status, reason);
}

export async function call(grantId: string, raw: z.input<typeof callInput>): Promise<CallResult> {
  const input = callInput.parse(raw);
  const row = getDb().select().from(brokerGrants).where(eq(brokerGrants.id, grantId)).get();
  const me = consumer();
  if (!row) throw notFound("Access");
  const api = apiRow(row.apiId);
  const verdict = evaluateCall(
    { ...row, status: row.status as GrantStatus },
    api,
    { id: me?.id ?? null, tokenId: me?.tokenId ?? null },
    { method: input.method as BrokerMethod, path: input.path },
    Date.now(),
  );
  if (!verdict.ok) {
    // Another caller gets the same answer as for a reference that does not exist.
    if (verdict.code === "caller") {
      audit({
        action: "broker.call",
        entityKind: "brokerGrant",
        entityId: row.id,
        entityName: api.name,
        workspaceId: row.workspaceId,
        changes: [],
        result: "denied",
        meta: { apiId: api.id, code: "caller" },
      });
      throw notFound("Access");
    }
    return deny(row, api, 403, verdict.code, verdict.reason, input);
  }

  let target;
  try {
    target = buildTarget(parseBaseUrl(api.baseUrl), input.path);
  } catch (error) {
    if (error instanceof TargetError) return deny(row, api, 400, "path", error.message, input);
    throw error;
  }
  const injection = api.injection as unknown as Injection;
  let headers: [string, string][];
  try {
    headers = consumerHeaders(input.headers, injection);
  } catch (error) {
    return deny(row, api, 400, "headers", (error as Error).message, input);
  }
  let body: Buffer | undefined;
  if (input.body !== undefined || input.bodyBase64 !== undefined) {
    body =
      input.bodyBase64 !== undefined
        ? Buffer.from(input.bodyBase64, "base64")
        : Buffer.from(input.body ?? "");
    if (body.length > MAX_REQUEST_BYTES)
      return deny(row, api, 413, "size", "The request body is too large", input);
  }

  const vault = loadVaultForExecution(row.workspaceId, null, { unattended: true });
  const secret = vault.values[api.secretName];
  if (!secret)
    return deny(
      row,
      api,
      409,
      "secret",
      `The credential "${api.secretName}" is not available to the broker`,
      input,
    );
  const guarded = guardedSecrets({ vault: { [api.secretName]: secret }, vaultDomains: vault.domains });
  const sensitive = [secret];
  const attached = attachCredential(target.url, headers, injection, secret);

  const started = Date.now();
  try {
    const response = await sendRequest(
      {
        method: input.method,
        url: attached.url,
        headers: attached.headers,
        body,
        settings: {
          ...DEFAULT_SETTINGS,
          followRedirects: false,
          timeoutMs: CALL_TIMEOUT_MS,
          useCookieJar: false,
        },
      },
      {
        policy: getPolicy(),
        maxBodyBytes: MAX_RESPONSE_BYTES,
        guard: guarded.length ? (message) => checkVaultDomains(guarded, message) : undefined,
      },
    );
    const raw = Buffer.from(response.bodyBase64, "base64");
    const masked = redactBytes(raw, sensitive);
    const text = !response.isBinary && Buffer.from(masked.body.toString("utf8"), "utf8").equals(masked.body);
    const result: CallResult = {
      status: response.status,
      statusText: response.statusText,
      headers: safeResponseHeaders(response.headers, sensitive),
      contentType: response.contentType,
      ...(text ? { body: masked.body.toString("utf8") } : { bodyBase64: masked.body.toString("base64") }),
      size: response.size,
      truncated: response.truncated,
      redacted: masked.redacted,
    };
    getDb()
      .update(brokerGrants)
      .set({ lastUsedAt: Date.now(), useCount: row.useCount + 1 })
      .where(eq(brokerGrants.id, row.id))
      .run();
    audit({
      action: "broker.call",
      entityKind: "brokerGrant",
      entityId: row.id,
      entityName: `${row.consumerName} → ${api.name}`,
      workspaceId: row.workspaceId,
      changes: [],
      meta: {
        apiId: api.id,
        method: input.method,
        path: target.path,
        status: response.status,
        ms: Date.now() - started,
        redacted: masked.redacted,
      },
    });
    return result;
  } catch (error) {
    if (error instanceof HostPolicyError)
      return deny(row, api, 403, "policy", `Blocked by outbound policy: ${error.message}`, input);
    if (error instanceof RequestError) {
      if (error.code === "EVAULTDOMAIN")
        return deny(row, api, 403, "domain", redactText(error.message, sensitive), input);
      audit({
        action: "broker.call",
        entityKind: "brokerGrant",
        entityId: row.id,
        entityName: `${row.consumerName} → ${api.name}`,
        workspaceId: row.workspaceId,
        changes: [],
        result: "denied",
        meta: { apiId: api.id, method: input.method, path: target.path, code: error.code },
      });
      throw new HttpError(502, redactText(error.message, sensitive));
    }
    throw error;
  }
}
