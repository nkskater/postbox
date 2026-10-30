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
