import { eq } from "drizzle-orm";
import type { FlowActor } from "@/core/workflows/model";
import { currentCaller } from "../access-context";
import { authorize } from "../authorize";
import { getAuthState, type Caller } from "../caller";
import { getDb, schema } from "../db";
import { HttpError } from "../errors";
import { getUser } from "../users";

export function captureActor(): FlowActor {
  const caller = currentCaller();
  if (!caller) throw new HttpError(401, "Authentication required");
  return caller.kind === "user"
    ? { kind: "user", userId: caller.user.id, tokenId: caller.token?.id ?? null }
    : { kind: caller.kind };
}
/** Persistent capabilities retain identities after deletion and re-check current roles and key revocation. */
export function resolveActor(actor: FlowActor, workspaceId: string, action: "read" | "run" = "run"): Caller {
  let caller: Caller;
  if (actor.kind === "user") {
    const user = getUser(actor.userId);
    if (!user || user.disabled || user.deletedAt || (user.isService && !actor.tokenId))
      throw new HttpError(403, "Workflow actor is unavailable");
    if (actor.tokenId) {
      const token = getDb()
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, actor.tokenId))
        .get();
      if (
        !token ||
        token.userId !== user.id ||
        token.revokedAt !== null ||
        (token.expiresAt !== null && token.expiresAt <= Date.now())
      )
        throw new HttpError(403, "Workflow API key is unavailable");
      caller = {
        kind: "user",
        user,
        via: "token",
        token: { id: token.id, scope: token.scope, rateLimitPerMinute: token.rateLimitPerMinute },
      };
    } else caller = { kind: "user", user, via: "session" };
  } else {
    const state = getAuthState();
    if (state.hasUsers || (actor.kind === "env" ? !state.cfg : state.enabled))
      throw new HttpError(403, "Assign this workflow to a current account owner");
    caller = { kind: actor.kind };
  }
  authorize(caller, workspaceId, action);
  return caller;
}
