import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { oauth2Owner } from "./oauth2-owner";
import { getOwnedSession, touchSession } from "./ws-sessions";

/** The caller's gRPC session, with run access re-checked; unknown and foreign IDs both 404. */
export function requireGrpcSession(id: string) {
  const session = getOwnedSession(id, oauth2Owner(), "grpc");
  if (!session) throw new HttpError(404, "gRPC session not found");
  authorize(currentCaller(), session.workspaceId, "run");
  touchSession(session);
  return session;
}

export function grpcAction(run: () => void) {
  try {
    run();
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
}
