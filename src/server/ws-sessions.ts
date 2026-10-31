/**
 * Live WebSocket sessions relayed for the browser: the upstream connection lives
 * here, events stream to the opener as NDJSON and messages are sent through
 * separate POSTs. Sessions are bound to the user who opened them, bounded in
 * number and closed when idle.
 */
import { nanoid } from "nanoid";
import type { WsConnection } from "@/core/ws/client";

export const MAX_SESSIONS = 50;
export const IDLE_MS = 30 * 60 * 1000;

export interface WsSession {
  id: string;
  owner: string;
  workspaceId: string;
  connection: WsConnection;
  lastActive: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

const sessions = ((
  globalThis as unknown as { __postboxWsSessions?: Map<string, WsSession> }
).__postboxWsSessions ??= new Map());

export function sessionCount() {
  return sessions.size;
}

export function registerSession(owner: string, workspaceId: string, connection: WsConnection): WsSession {
  const id = nanoid();
  const session: WsSession = {
    id,
    owner,
    workspaceId,
    connection,
    lastActive: Date.now(),
    idleTimer: setTimeout(() => connection.close(1001, "Idle timeout"), IDLE_MS),
  };
  session.idleTimer.unref?.();
  sessions.set(id, session);
  return session;
}

export function touchSession(session: WsSession) {
  session.lastActive = Date.now();
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => session.connection.close(1001, "Idle timeout"), IDLE_MS);
  session.idleTimer.unref?.();
}

/** Unknown and foreign sessions look the same to callers. */
export function getOwnedSession(id: string, owner: string): WsSession | undefined {
  const s = sessions.get(id);
  return s && s.owner === owner ? s : undefined;
}

export function removeSession(id: string) {
  const s = sessions.get(id);
  if (s) clearTimeout(s.idleTimer);
  sessions.delete(id);
}
