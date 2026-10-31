/**
 * Live WebSocket sessions relayed for the browser: the upstream connection lives
 * here, events stream to the opener as NDJSON and messages are sent through
 * separate POSTs. Sessions are bound to the user who opened them, bounded in
 * number and closed when idle.
 */
import { nanoid } from "nanoid";
import type { WsConnection } from "@/core/ws/client";
import type { SocketIoConnection } from "@/core/socketio/client";

type Connection =
  { kind: "ws"; connection: WsConnection } | { kind: "socketio"; connection: SocketIoConnection };
const closeIdle = (c: Connection) =>
  c.kind === "ws" ? c.connection.close(1001, "Idle timeout") : c.connection.close();

export const MAX_SESSIONS = 50;
export const IDLE_MS = 30 * 60 * 1000;

export type WsSession = Connection & {
  id: string;
  owner: string;
  workspaceId: string;
  lastActive: number;
  idleTimer: ReturnType<typeof setTimeout>;
};

const sessions = ((
  globalThis as unknown as { __postboxWsSessions?: Map<string, WsSession> }
).__postboxWsSessions ??= new Map());

export function sessionCount() {
  return sessions.size;
}

export function registerSession(owner: string, workspaceId: string, conn: Connection): WsSession {
  const id = nanoid();
  const session = {
    ...conn,
    id,
    owner,
    workspaceId,
    lastActive: Date.now(),
    idleTimer: setTimeout(() => closeIdle(conn), IDLE_MS),
  } as WsSession;
  session.idleTimer.unref?.();
  sessions.set(id, session);
  return session;
}

export function touchSession(session: WsSession) {
  session.lastActive = Date.now();
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => closeIdle(session), IDLE_MS);
  session.idleTimer.unref?.();
}

/** Unknown and foreign sessions look the same to callers. */
export function getOwnedSession(id: string, owner: string): WsSession | undefined;
export function getOwnedSession<K extends WsSession["kind"]>(
  id: string,
  owner: string,
  kind: K,
): Extract<WsSession, { kind: K }> | undefined;
export function getOwnedSession(id: string, owner: string, kind?: WsSession["kind"]): WsSession | undefined {
  const s = sessions.get(id);
  return s && s.owner === owner && (!kind || s.kind === kind) ? s : undefined;
}

export function removeSession(id: string) {
  const s = sessions.get(id);
  if (s) clearTimeout(s.idleTimer);
  sessions.delete(id);
}
