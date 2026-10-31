import { currentCaller } from "./access-context";

/** Identity an authorization-code login is bound to: the signed-in user, or the shared login. */
export function oauth2Owner(): string {
  const caller = currentCaller();
  return caller?.kind === "user" ? `user:${caller.user.id}` : (caller?.kind ?? "anonymous");
}
