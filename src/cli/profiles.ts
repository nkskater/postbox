import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./errors";

/** A saved Postbox server. The token is stored in the file or read from `tokenEnv` at use time. */
export interface Profile {
  url: string;
  token?: string;
  tokenEnv?: string;
}
export interface ProfileStore {
  current?: string;
  profiles: Record<string, Profile>;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POSTBOX_CONFIG) return env.POSTBOX_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "postbox", "profiles.json");
}

export async function loadStore(env: NodeJS.ProcessEnv = process.env): Promise<ProfileStore> {
  let text: string;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<ProfileStore>;
    return {
      current: typeof parsed.current === "string" ? parsed.current : undefined,
      profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
    };
  } catch {
    throw new CliError(`Profile file ${configPath(env)} is not valid JSON.`, EXIT.usage);
  }
}

/** Writes atomically and keeps the file readable by its owner only; it can hold tokens. */
export async function saveStore(store: ProfileStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = configPath(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

/** http(s) only, no embedded credentials, no trailing slash. */
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`"${value}" is not a valid URL.`, EXIT.usage);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new CliError("The server URL must use http or https.", EXIT.usage);
  if (url.username || url.password)
    throw new CliError("Do not put credentials in the server URL; use a token.", EXIT.usage);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function maskToken(token?: string): string {
  if (!token) return "";
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-2)}`;
}

export interface Connection {
  url: string;
  token?: string;
  profile?: string;
}

/**
 * Precedence: explicit flags, then POSTBOX_URL / POSTBOX_TOKEN, then the named
 * or current profile. A profile's `tokenEnv` is resolved here, never stored.
 */
export async function resolveConnection(
  flags: { profile?: string; url?: string; token?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Connection> {
  const store = await loadStore(env);
  const name = flags.profile || env.POSTBOX_PROFILE || store.current;
  const saved = name ? store.profiles[name] : undefined;
  if (flags.profile && !saved) throw new CliError(`No profile named "${flags.profile}".`, EXIT.usage);
  const url = flags.url || env.POSTBOX_URL || saved?.url;
  if (!url)
    throw new CliError(
      "No server configured. Run `postbox profile add <name> <url>` or set POSTBOX_URL.",
      EXIT.usage,
    );
  const fromProfile = saved?.tokenEnv ? env[saved.tokenEnv] : saved?.token;
  return {
    url: normalizeServerUrl(url),
    token: flags.token || env.POSTBOX_TOKEN || fromProfile,
    profile: saved ? name : undefined,
  };
}
