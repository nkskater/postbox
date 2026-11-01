/**
 * API key scopes. A key can never do more than its owner could; a scope narrows it further.
 *   read   look at data only
 *   run    read, and send requests / run collections
 *   write  run, and create or change workspace content
 *   full   everything the owner may do, including managing members, keys and the instance
 */
export type WorkspaceActionName = "read" | "write" | "run" | "manage";
export type KeyScope = "read" | "run" | "write" | "full";

export const KEY_SCOPES: readonly KeyScope[] = ["read", "run", "write", "full"];

export const SCOPE_ACTIONS: Record<KeyScope, readonly WorkspaceActionName[]> = {
  read: ["read"],
  run: ["read", "run"],
  write: ["read", "run", "write"],
  full: ["read", "run", "write", "manage"],
};

export const SCOPE_LABELS: Record<KeyScope, string> = {
  read: "Read only",
  run: "Read and run requests",
  write: "Read, run and edit",
  full: "Full access",
};

export const isKeyScope = (value: unknown): value is KeyScope =>
  typeof value === "string" && (KEY_SCOPES as readonly string[]).includes(value);

export const scopeAllows = (scope: KeyScope, action: WorkspaceActionName) =>
  SCOPE_ACTIONS[scope].includes(action);

/** True when `scope` is at least as powerful as `needed`. */
export const scopeAtLeast = (scope: KeyScope, needed: KeyScope) =>
  KEY_SCOPES.indexOf(scope) >= KEY_SCOPES.indexOf(needed);
