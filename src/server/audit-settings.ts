import { resolveSettings } from "@/lib/settings/registry";
import { pruneAudit } from "./audit";
import { pruneUsage } from "./usage";
import { pruneHookEvents } from "./hook-listeners";
import { pruneWebhooks } from "./webhooks";
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
  const values = resolveSettings(readSavedSettings(), process.env).values;
  pruneUsage(values["usage.retentionDays"] as number, at);
  pruneWebhooks(values["webhooks.retentionDays"] as number, at);
  pruneHookEvents(values["hooks.retentionDays"] as number, at);
  return pruneAudit(values["audit.retentionDays"] as number, at);
}
