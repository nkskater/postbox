/**
 * Where the vault's encryption keys come from. They are never stored in the database or in backups.
 *
 *   1. POSTBOX_VAULT_KEY (32 bytes, base64 or hex), with POSTBOX_VAULT_PREVIOUS_KEYS (comma list) for values not
 *      yet re-encrypted after a rotation. Best for containers and secret managers.
 *   2. POSTBOX_VAULT_KEY_FILE: a key file at that path, created on first use.
 *   3. `vault.keys.json` next to the database file, created on first use (mode 0600). Convenient, but it sits on the
 *      same disk as the database: mount it from separate storage, or use 1 or 2, to separate them.
 *
 * A key file is JSON `{ "current": "<id>", "keys": { "<id>": "<base64url key>" } }`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  VaultCryptoError,
  buildKeyring,
  encodeKey,
  generateKey,
  keyIdOf,
  parseKey,
  type Keyring,
} from "@/core/vault/crypto";
import { resolveDatabasePath } from "./db";

export type KeySource = "environment" | "file";

export interface LoadedKeys {
  ring: Keyring;
  source: KeySource;
  /** The key file, when the source is a file. */
  file: string | null;
}

const holder = globalThis as unknown as { __postboxVaultKeys?: { fingerprint: string; keys: LoadedKeys } };

function keyFilePath(): string {
  return (
    process.env.POSTBOX_VAULT_KEY_FILE?.trim() ||
    path.join(path.dirname(resolveDatabasePath()), "vault.keys.json")
  );
}

interface KeyFile {
  current: string;
  keys: Record<string, string>;
}

function writeKeyFile(file: string, data: KeyFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readKeyFile(file: string): LoadedKeys {
  let data: KeyFile;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) as KeyFile;
  } catch (error) {
    throw new VaultCryptoError(
      `The vault key file ${file} cannot be read: ${(error as Error).message}`,
      "bad-key",
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [id, text] of Object.entries(data.keys ?? {})) {
    const key = parseKey(text);
    if (keyIdOf(key) !== id)
      throw new VaultCryptoError(`Key ${id} in ${file} does not match its id`, "bad-key");
    keys.set(id, key);
  }
  const current = keys.get(data.current);
  if (!current)
    throw new VaultCryptoError(
      `The vault key file ${file} names a current key it does not contain`,
      "bad-key",
    );
  return { ring: buildKeyring(current, [...keys.values()]), source: "file", file };
}

function fingerprint(): string {
  const file = keyFilePath();
  let stamp = "";
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* not created yet */
  }
  return [
    process.env.POSTBOX_VAULT_KEY ?? "",
    process.env.POSTBOX_VAULT_PREVIOUS_KEYS ?? "",
    file,
    stamp,
  ].join("|");
}

/** True once keys exist or are configured; reading status must not create a key file as a side effect. */
export function keysExist(): boolean {
  return !!process.env.POSTBOX_VAULT_KEY?.trim() || fs.existsSync(keyFilePath());
}

/** The active keys. Creates a key file on first use when no key is configured. */
export function getKeys(): LoadedKeys {
  const print = fingerprint();
  if (holder.__postboxVaultKeys?.fingerprint === print) return holder.__postboxVaultKeys.keys;
  let keys: LoadedKeys;
  if (process.env.POSTBOX_VAULT_KEY?.trim()) {
    const previous = (process.env.POSTBOX_VAULT_PREVIOUS_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map(parseKey);
    keys = {
      ring: buildKeyring(parseKey(process.env.POSTBOX_VAULT_KEY), previous),
      source: "environment",
      file: null,
    };
  } else {
    const file = keyFilePath();
    if (!fs.existsSync(file)) {
      const key = generateKey();
      writeKeyFile(file, { current: keyIdOf(key), keys: { [keyIdOf(key)]: encodeKey(key) } });
    }
    keys = readKeyFile(file);
  }
  holder.__postboxVaultKeys = { fingerprint: fingerprint(), keys };
  return keys;
}

/** Add a fresh key to the key file and make it current. Only possible for file-managed keys. */
export function addKeyToFile(): LoadedKeys {
  const loaded = getKeys();
  if (loaded.source !== "file" || !loaded.file)
    throw new VaultCryptoError(
      "The vault key comes from POSTBOX_VAULT_KEY. Set a new key there, move the old one to POSTBOX_VAULT_PREVIOUS_KEYS, restart, then re-encrypt.",
      "bad-key",
    );
  const key = generateKey();
  const keys = Object.fromEntries([...loaded.ring.all].map(([id, k]) => [id, encodeKey(k)]));
  keys[keyIdOf(key)] = encodeKey(key);
  writeKeyFile(loaded.file, { current: keyIdOf(key), keys });
  holder.__postboxVaultKeys = undefined;
  return getKeys();
}

/** Drop key ids from the file once no secret uses them. */
export function pruneFileKeys(inUse: Set<string>): string[] {
  const loaded = getKeys();
  if (loaded.source !== "file" || !loaded.file) return [];
  const keep = Object.fromEntries(
    [...loaded.ring.all]
      .filter(([id]) => id === loaded.ring.current.id || inUse.has(id))
      .map(([id, k]) => [id, encodeKey(k)]),
  );
  const removed = [...loaded.ring.all.keys()].filter((id) => !(id in keep));
  if (removed.length) {
    writeKeyFile(loaded.file, { current: loaded.ring.current.id, keys: keep });
    holder.__postboxVaultKeys = undefined;
  }
  return removed;
}

export function resetKeyCache() {
  holder.__postboxVaultKeys = undefined;
}
