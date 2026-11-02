/**
 * Instance-wide execution settings (App Settings → Request execution) in the shape
 * the core engine takes. Read on every execution so changes apply immediately.
 */
import type { RequestDefaults } from "@/core/http/prepare";
import type { ScriptLimits } from "@/core/scripts/sandbox";
import { resolveSettings, type HeaderRow } from "@/lib/settings/registry";
import { readSavedSettings } from "./settings";

export interface ExecutionSettings {
  requestDefaults: RequestDefaults;
  scriptLimits: Partial<ScriptLimits>;
}

export function executionSettings(env: NodeJS.ProcessEnv = process.env): ExecutionSettings {
  const { values } = resolveSettings(readSavedSettings(), env);
  return {
    requestDefaults: {
      headers: values["execution.defaultHeaders"] as HeaderRow[],
      userAgent: values["execution.userAgent"] as string,
      autoAcceptHeaders: values["execution.autoAcceptHeaders"] as boolean,
    },
    scriptLimits: {
      timeoutMs: values["execution.scriptTimeoutMs"] as number,
      memoryBytes: (values["execution.scriptMemoryMb"] as number) * 1024 * 1024,
    },
  };
}

/** Current run admission limits (read on every reservation so changes apply immediately). */
export function runQueueLimits(env: NodeJS.ProcessEnv = process.env): {
  maxActive: number;
  maxQueued: number;
} {
  const { values } = resolveSettings(readSavedSettings(), env);
  return {
    maxActive: values["execution.maxActiveRuns"] as number,
    maxQueued: values["execution.maxQueuedRuns"] as number,
  };
}

/** Current history retention rules (read on every recorded request so changes apply immediately). */
export function historySettings(env: NodeJS.ProcessEnv = process.env): {
  limit: number;
  retentionDays: number;
  skipSecrets: boolean;
} {
  const { values } = resolveSettings(readSavedSettings(), env);
  return {
    limit: values["history.limit"] as number,
    retentionDays: values["history.retentionDays"] as number,
    skipSecrets: values["history.skipSecrets"] as boolean,
  };
}

/** Current load-test ceilings (read at admission so changes apply to the next test). */
export function loadLimits(env: NodeJS.ProcessEnv = process.env): {
  maxVus: number;
  maxDurationSec: number;
  maxRequests: number;
} {
  const { values } = resolveSettings(readSavedSettings(), env);
  return {
    maxVus: values["load.maxVus"] as number,
    maxDurationSec: values["load.maxDurationSec"] as number,
    maxRequests: values["load.maxRequests"] as number,
  };
}
