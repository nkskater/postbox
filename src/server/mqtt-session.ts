import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { oauth2Owner } from "./oauth2-owner";
import { getOwnedSession, touchSession } from "./ws-sessions";

/** The caller's MQTT session, with run access re-checked; unknown and foreign IDs both 404. */
export function requireMqttSession(id: string) {
  const session = getOwnedSession(id, oauth2Owner(), "mqtt");
  if (!session) throw new HttpError(404, "MQTT session not found");
  authorize(currentCaller(), session.workspaceId, "run");
  touchSession(session);
  return session;
}

export async function mqttAction(run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
}
