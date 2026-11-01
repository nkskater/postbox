/**
 * Persistence and resolution for app settings (see src/lib/settings/registry.ts).
 */
import { and, eq, inArray } from "drizzle-orm";
import { currentCaller } from "./access-context";
import { requireAdmin } from "./authorize";
import { isAdmin } from "./caller";
import { getDb, schema } from "./db";
import {
  BROWSER_SETTING_KEYS,
  SETTINGS,
  defaultValues,
  resolveSettings,
  sanitizeSettings,
  type SettingValue,
} from "@/lib/settings/registry";

const { appSettings } = schema;

/** Settings that are only configurable through environment variables (shown read-only). */
export interface EnvSetting {
  name: string;
  value: string;
  description: string;
  isSet: boolean;
}

const ENV_SETTINGS: { name: string; description: string; secret?: boolean; fallback?: string }[] = [
  { name: "POSTBOX_PASSWORD", description: "Password for the web login", secret: true },
  { name: "POSTBOX_TOKEN", description: "Bearer token for API, scripts and MCP clients", secret: true },
  { name: "POSTBOX_SESSION_DAYS", description: "Login session lifetime (days)", fallback: "30" },
  { name: "DATABASE_PATH", description: "SQLite database file" },
  { name: "PROXY_ALLOW_HOSTS", description: "Hosts requests may target (empty = all)" },
  { name: "PROXY_DENY_HOSTS", description: "Hosts that are always blocked" },
  { name: "PROXY_ALLOW_SOCKETS", description: "Unix sockets / named pipes requests may use (empty = none)" },
  { name: "MCP_ALLOWED_ORIGINS", description: "Extra browser origins allowed to call /api/mcp" },
  { name: "MCP_ENABLED", description: "Serve the MCP endpoint (true/false)", fallback: "true" },
  { name: "MCP_READ_ONLY", description: "Block MCP tools that change data (true/false)", fallback: "false" },
  { name: "SCRIPT_TIMEOUT_MS", description: "Script time limit", fallback: "5000" },
  { name: "SCRIPT_MEMORY_MB", description: "Script memory limit", fallback: "32" },
  { name: "API_BODY_LIMIT_MB", description: "Largest API/MCP request body", fallback: "25" },
  { name: "RESPONSE_MAX_BYTES", description: "Maximum response size", fallback: "52428800" },
  { name: "HISTORY_LIMIT", description: "History entries kept per workspace", fallback: "500" },
];

export function listEnvSettings(env: NodeJS.ProcessEnv = process.env): EnvSetting[] {
  return ENV_SETTINGS.map((e) => {
    const raw = env[e.name];
    const isSet = raw !== undefined && raw !== "";
    // Secrets are never sent to the browser; only whether they are configured.
    const value = e.secret ? (isSet ? "configured" : "not set") : isSet ? raw! : (e.fallback ?? "not set");
    return {
      name: e.name,
      description: e.description,
      value: e.name === "DATABASE_PATH" && !isSet ? "default" : value,
      isSet,
    };
  });
}

const browserKey = (key: string) => BROWSER_SETTING_KEYS.includes(key);
export function readSavedSettings(): Record<string, unknown> {
  const caller = currentCaller();
  const rows = getDb().select().from(appSettings).all();
  if (caller?.kind !== "user") return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const personal = getDb()
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, caller.user.id))
    .all();
  return Object.fromEntries(
    [...rows.filter((r) => !browserKey(r.key)), ...personal].map((r) => [r.key, r.value]),
  );
}
const canManageInstance = () => !currentCaller() || isAdmin(currentCaller()!);
function checkInstanceKeys(keys: string[]) {
  if (keys.some((key) => SETTINGS.find((def) => def.key === key)?.scope === "server")) requireAdmin();
}

export interface SettingsPayload {
  values: Record<string, SettingValue>;
  saved: Record<string, unknown>;
  defaults: Record<string, SettingValue>;
  envLocked: Record<string, string>;
  environment: EnvSetting[];
}

export function getSettings(env: NodeJS.ProcessEnv = process.env): SettingsPayload {
  const saved = readSavedSettings();
  const { values, envLocked } = resolveSettings(saved, env);
  return {
    values,
    saved: canManageInstance()
      ? saved
      : Object.fromEntries(Object.entries(saved).filter(([key]) => browserKey(key))),
    defaults: defaultValues(),
    envLocked,
    environment: canManageInstance() ? listEnvSettings(env) : [],
  };
}

/** Apply a partial update; `null` resets a key to its default. Throws on invalid input. */
export function patchSettings(patch: Record<string, unknown>): SettingsPayload {
  const { valid, errors } = sanitizeSettings(patch);
  if (errors.length) throw new Error(errors.join("; "));
  checkInstanceKeys(Object.keys(valid));
  const db = getDb();
  const caller = currentCaller();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(valid)) {
      if (browserKey(key) && caller?.kind === "user") {
        const where = and(eq(schema.userSettings.userId, caller.user.id), eq(schema.userSettings.key, key));
        if (value === null) tx.delete(schema.userSettings).where(where).run();
        else
          tx.insert(schema.userSettings)
            .values({ userId: caller.user.id, key, value, updatedAt: Date.now() })
            .onConflictDoUpdate({
              target: [schema.userSettings.userId, schema.userSettings.key],
              set: { value, updatedAt: Date.now() },
            })
            .run();
      } else {
        if (value === null) tx.delete(appSettings).where(eq(appSettings.key, key)).run();
        else
          tx.insert(appSettings)
            .values({ key, value, updatedAt: Date.now() })
            .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } })
            .run();
      }
    }
  });
  return getSettings();
}

/** Replace all saved settings with an exported set. Unknown or invalid entries are skipped and reported. */
export function importSettings(input: Record<string, unknown>): {
  settings: SettingsPayload;
  skipped: string[];
} {
  const { valid, errors } = sanitizeSettings(input);
  checkInstanceKeys(Object.keys(valid));
  const db = getDb();
  const caller = currentCaller();
  db.transaction((tx) => {
    if (caller?.kind === "user") {
      tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, caller.user.id)).run();
      if (canManageInstance())
        tx.delete(appSettings)
          .where(
            inArray(
              appSettings.key,
              SETTINGS.filter((def) => def.scope === "server").map((def) => def.key),
            ),
          )
          .run();
    } else tx.delete(appSettings).run();
    patchSettings(valid);
  });
  return { settings: getSettings(), skipped: errors };
}

export function exportSettings() {
  return { postboxSettings: 1, exportedAt: new Date().toISOString(), settings: getSettings().saved };
}
