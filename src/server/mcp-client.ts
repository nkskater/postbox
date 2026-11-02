import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  mcpCallSchema,
  mcpConnectionSchema,
  mcpActionSchema,
  type McpCall,
  type McpConnectionConfig,
  type McpAction,
} from "@/core/mcp-client/model";
import { connectExternalMcp, McpClientError, type ExternalMcpClient } from "@/core/mcp-client/client";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { credentialRedactionValues, sensitiveFieldValues } from "@/core/retention";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { oauth2Owner } from "./oauth2-owner";
import { loadScopes, getPolicy } from "./context";
import { HttpError } from "./errors";
const { mcpCalls } = schema;
export const mcpSaveSchema = mcpCallSchema.extend({ workspaceId: z.string().min(1) });
export const mcpPatchSchema = mcpCallSchema.extend({ expectedRevision: z.number().int().positive() });
export const mcpConnectSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  connection: mcpConnectionSchema,
});
export const mcpRunSchema = z.object({ action: mcpActionSchema });
const sensitive = /authorization|cookie|token|password|secret|api[-_]?key|credential|session/i;
function validateSaved(call: McpCall) {
  if (Buffer.byteLength(JSON.stringify(call)) > 262144)
    throw new HttpError(400, "Saved MCP call exceeds 256 KiB");
  let url: URL;
  try {
    url = new URL(call.connection.url.replace(/^\{\{[^{}]+\}\}/, "https://template.invalid"));
  } catch {
    throw new HttpError(400, "Use an HTTP(S) endpoint or a leading base URL variable");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new HttpError(400, "MCP endpoint must use HTTP(S) without embedded credentials or fragment");
  for (const h of call.connection.headers)
    if (sensitive.test(h.key) && h.value && !/^(?:(?:Bearer|Basic) )?\{\{\s*[^{}]+\s*\}\}$/i.test(h.value))
      throw new HttpError(400, "Save credentials as {{variable}} references");
  for (const [key, value] of url.searchParams)
    if (sensitive.test(key) && value && !/^\{\{\s*[^{}]+\s*\}\}$/.test(value))
      throw new HttpError(400, "Save URL credentials as {{variable}} references");
  for (const value of sensitiveFieldValues(call.action))
    if (value && !/^\{\{\s*[^{}]+\s*\}\}$/.test(value))
      throw new HttpError(400, "Save sensitive arguments as {{variable}} references");
}
export function listMcpCalls(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(mcpCalls)
    .where(eq(mcpCalls.workspaceId, workspaceId))
    .orderBy(asc(mcpCalls.name), asc(mcpCalls.id))
    .all();
}
export function getMcpCall(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(mcpCalls).where(eq(mcpCalls.id, id)).get();
  if (!row) throw new HttpError(404, "MCP call not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
export function saveMcpCall(raw: z.input<typeof mcpSaveSchema>) {
  const { workspaceId, ...config } = mcpSaveSchema.parse(raw);
  authorize(currentCaller(), workspaceId, "write");
  validateSaved(config);
  if (listMcpCalls(workspaceId).length >= 500)
    throw new HttpError(429, "At most 500 saved MCP calls per workspace");
  const id = newId(),
    now = Date.now();
  getDb()
    .insert(mcpCalls)
    .values({ id, workspaceId, name: config.name, config, revision: 1, createdAt: now, updatedAt: now })
    .run();
  return getMcpCall(id);
}
export function updateMcpCall(id: string, raw: z.input<typeof mcpPatchSchema>) {
  getMcpCall(id, "write");
  const { expectedRevision, ...config } = mcpPatchSchema.parse(raw);
  validateSaved(config);
  const updated = getDb()
    .update(mcpCalls)
    .set({ name: config.name, config, revision: expectedRevision + 1, updatedAt: Date.now() })
    .where(and(eq(mcpCalls.id, id), eq(mcpCalls.revision, expectedRevision)))
    .run();
  if (!updated.changes) throw new HttpError(409, "MCP call changed; reload before saving");
  return getMcpCall(id);
}
export function deleteMcpCall(id: string) {
  getMcpCall(id, "write");
  getDb().delete(mcpCalls).where(eq(mcpCalls.id, id)).run();
  return { ok: true };
}
interface Session {
  id: string;
  owner: string;
  workspaceId: string;
  connection: ExternalMcpClient;
  secrets: string[];
  resolver: Resolver;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
  createdAt: number;
  lastActive: number;
}
const state = ((
  globalThis as unknown as {
    __postboxMcpClient?: {
      sessions: Map<string, Session>;
      pending: number;
      pendingOwners: Map<string, number>;
    };
  }
).__postboxMcpClient ??= { sessions: new Map(), pending: 0, pendingOwners: new Map() });
const IDLE_MS = 10 * 60 * 1000;
function renew(session: Session) {
  session.lastActive = Date.now();
  clearTimeout(session.timer);
  session.timer = setTimeout(
    () => {
      void endMcpSession(session.id);
    },
    Math.min(IDLE_MS, Math.max(1, session.createdAt + 30 * 60 * 1000 - Date.now())),
  );
  session.timer.unref?.();
}
export async function endMcpSession(id: string) {
  const session = state.sessions.get(id);
  if (!session) return;
  state.sessions.delete(id);
  clearTimeout(session.timer);
  await session.connection.close();
}
function owned(id: string) {
  const session = state.sessions.get(id);
  if (!session || session.owner !== oauth2Owner()) throw new HttpError(404, "MCP session not found");
  try {
    authorize(currentCaller(), session.workspaceId, "run");
  } catch (error) {
    void endMcpSession(id);
    throw error;
  }
  if (Date.now() - session.lastActive >= IDLE_MS || Date.now() - session.createdAt >= 30 * 60 * 1000) {
    void endMcpSession(id);
    throw new HttpError(404, "MCP session expired");
  }
  renew(session);
  return session;
}
export async function closeMcpSession(id: string) {
  owned(id);
  await endMcpSession(id);
  return { ok: true };
}
function resolved<T>(value: T, resolver: Resolver, depth = 0): T {
  if (depth > 32) throw new HttpError(400, "MCP argument depth exceeds 32");
  if (typeof value === "string") return resolver.resolve(value) as T;
  if (Array.isArray(value)) return value.map((v) => resolved(v, resolver, depth + 1)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolved(v, resolver, depth + 1)]),
    ) as T;
  return value;
}
function unresolved(resolver: Resolver) {
  if (resolver.unresolved.size)
    throw new HttpError(400, "Resolve all MCP variables before connecting or running a call");
}
function fault(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof McpClientError)
    throw new HttpError(
      error.code === "auth"
        ? 502
        : error.code === "policy"
          ? 403
          : error.code === "limit"
            ? 413
            : error.code === "timeout"
              ? 504
              : 502,
      `${error.code}: ${error.message}`,
    );
  throw new HttpError(400, "Invalid MCP endpoint or operation");
}
export async function openMcpSession(raw: z.input<typeof mcpConnectSchema>) {
  const input = mcpConnectSchema.parse(raw);
  const owner = oauth2Owner();
  authorize(currentCaller(), input.workspaceId, "run");
  if (
    state.sessions.size + state.pending >= 50 ||
    [...state.sessions.values()].filter((s) => s.owner === owner).length +
      (state.pendingOwners.get(owner) ?? 0) >=
      10
  )
    throw new HttpError(429, "Too many open MCP sessions");
  const context = loadScopes(input.workspaceId, input.environmentId ?? null, null),
    resolver = new Resolver(context.scopes);
  const config = resolved(input.connection, resolver) as McpConnectionConfig;
  unresolved(resolver);
  let endpoint: URL;
  try {
    endpoint = new URL(config.url);
  } catch {
    throw new HttpError(400, "Invalid MCP endpoint URL");
  }
  const secrets = credentialRedactionValues([
    ...context.secrets,
    ...config.headers
      .filter((h) => sensitive.test(h.key))
      .flatMap((h) => [
        h.value,
        ...(/^authorization$/i.test(h.key)
          ? [
              h.value.replace(/^\S+\s+/, ""),
              ...(/^Basic /i.test(h.value)
                ? [Buffer.from(h.value.slice(6), "base64").toString("utf8").split(":").slice(1).join(":")]
                : []),
            ]
          : []),
      ]),
    ...Array.from(endpoint.searchParams)
      .filter(([key]) => sensitive.test(key))
      .map(([, value]) => value),
  ]);
  state.pending++;
  state.pendingOwners.set(owner, (state.pendingOwners.get(owner) ?? 0) + 1);
  try {
    const connection = await connectExternalMcp(config, getPolicy());
    const id = newId();
    const session: Session = {
      id,
      owner: oauth2Owner(),
      workspaceId: input.workspaceId,
      connection,
      secrets,
      resolver,
      timer: setTimeout(() => {}, 0),
      busy: false,
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    state.sessions.set(id, session);
    renew(session);
    return { id, ...redactStoredValue(connection.info, secrets) };
  } catch (error) {
    fault(error);
  } finally {
    state.pending--;
    const remaining = (state.pendingOwners.get(owner) ?? 1) - 1;
    if (remaining) state.pendingOwners.set(owner, remaining);
    else state.pendingOwners.delete(owner);
  }
}
export async function runMcpAction(id: string, raw: McpAction) {
  const session = owned(id);
  if (session.busy) throw new HttpError(409, "An MCP operation is already running");
  if (Buffer.byteLength(JSON.stringify(raw)) > 262144)
    throw new HttpError(400, "MCP arguments exceed 256 KiB");
  session.resolver.unresolved.clear();
  const action = resolved(mcpActionSchema.parse(raw), session.resolver);
  unresolved(session.resolver);
  const secrets = [
    ...new Set([...session.secrets, ...credentialRedactionValues(sensitiveFieldValues(action))]),
  ];
  if (
    secrets.length > 5000 ||
    secrets.reduce((size, value) => size + Buffer.byteLength(value), 0) > 2 * 1048576
  )
    throw new HttpError(413, "MCP credential redaction budget exceeded");
  session.secrets = secrets;
  session.busy = true;
  try {
    return redactStoredValue(await session.connection.run(action), session.secrets);
  } catch (error) {
    fault(error);
  } finally {
    session.busy = false;
  }
}
export function mcpSessionCount() {
  return state.sessions.size;
}
