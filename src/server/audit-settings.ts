import { resolveSettings } from "@/lib/settings/registry";
import { pruneAudit } from "./audit";
import { readSavedSettings } from "./settings";

/** Days to keep audit events; 0 keeps them forever. Read on use, so changes apply at once. */
export function auditRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return resolveSettings(readSavedSettings(), env).values["audit.retentionDays"] as number;
}

let lastPrune = 0;
/** Apply the retention setting at most once an hour. Called from the request wrapper. */
export function pruneAuditIfDue(at = Date.now()): number {
  if (at - lastPrune < 3_600_000) return 0;
  lastPrune = at;
  return pruneAudit(auditRetentionDays(), at);
}
