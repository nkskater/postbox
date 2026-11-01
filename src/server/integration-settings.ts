/**
 * Instance settings for MCP and sign-in (App Settings → MCP & integrations, Security & about).
 * Read on every use so a change applies immediately.
 */
import { resolveSettings } from "@/lib/settings/registry";
import { readSavedSettings } from "./settings";

export interface McpSettings {
  enabled: boolean;
  readOnly: boolean;
  /** Normalised extra origins (no trailing slash). */
  allowedOrigins: string[];
}

export const parseOrigins = (value: string): string[] =>
  value
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

export function mcpSettings(env: NodeJS.ProcessEnv = process.env): McpSettings {
  const { values } = resolveSettings(readSavedSettings(), env);
  return {
    enabled: values["mcp.enabled"] as boolean,
    readOnly: values["mcp.readOnly"] as boolean,
    allowedOrigins: parseOrigins(values["mcp.allowedOrigins"] as string),
  };
}
