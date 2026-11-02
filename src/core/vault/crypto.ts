/**
 * Encryption for the secrets vault: AES-256-GCM with a random 96-bit nonce per value, keys identified by a short
 * fingerprint so values stay readable after a rotation. The secret's name and workspace are authenticated as
 * additional data, so a stored value cannot be moved to another secret or workspace undetected. Pure: no I/O.
 *
 * Stored form: `v1.<keyId>.<nonce>.<ciphertext+tag>` with base64url parts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class VaultCryptoError extends Error {
  constructor(
    message: string,
    public code: "bad-key" | "unknown-key" | "malformed" | "tampered",
  ) {
    super(message);
    this.name = "VaultCryptoError";
  }
}

/** A key's id: the first 8 hex digits of the SHA-256 of the key bytes (not reversible). */
export const keyIdOf = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

/** Accepts 32 bytes as base64, base64url or 64 hex digits. */
export function parseKey(text: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64url");
  if (key.length !== KEY_BYTES)
    throw new VaultCryptoError(`A vault key must be ${KEY_BYTES} bytes (base64 or 64 hex digits)`, "bad-key");
  return key;
}

export const generateKey = () => randomBytes(KEY_BYTES);
export const encodeKey = (key: Buffer) => key.toString("base64url");

export interface Keyring {
  /** The key new values are encrypted with. */
  current: { id: string; key: Buffer };
  /** Every key a stored value may still be encrypted with, the current one included. */
  all: Map<string, Buffer>;
}

export function buildKeyring(current: Buffer, previous: Buffer[] = []): Keyring {
  const all = new Map<string, Buffer>();
  for (const key of [...previous, current]) all.set(keyIdOf(key), key);
  return { current: { id: keyIdOf(current), key: current }, all };
}

const aad = (workspaceId: string, name: string) => Buffer.from(`postbox-vault\0${workspaceId}\0${name}`);

export function encryptSecret(ring: Keyring, workspaceId: string, name: string, value: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ring.current.key, nonce);
  cipher.setAAD(aad(workspaceId, name));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    keyId: ring.current.id,
    ciphertext: `v1.${ring.current.id}.${nonce.toString("base64url")}.${body.toString("base64url")}`,
  };
}

/** The key id a stored value names, or null when it is not in the vault format. */
export function keyIdOfCiphertext(ciphertext: string): string | null {
  const m = /^v1\.([0-9a-f]{8})\.[\w-]+\.[\w-]+$/.exec(ciphertext);
  return m ? m[1] : null;
}

export function decryptSecret(ring: Keyring, workspaceId: string, name: string, ciphertext: string): string {
  const m = /^v1\.([0-9a-f]{8})\.([\w-]+)\.([\w-]+)$/.exec(ciphertext);
  if (!m) throw new VaultCryptoError("The stored secret is not in the vault format", "malformed");
  const key = ring.all.get(m[1]);
  if (!key)
    throw new VaultCryptoError(`The key ${m[1]} that encrypted this secret is not available`, "unknown-key");
  const nonce = Buffer.from(m[2], "base64url");
  const body = Buffer.from(m[3], "base64url");
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES)
    throw new VaultCryptoError("The stored secret is truncated", "malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(workspaceId, name));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VaultCryptoError(
      "The stored secret failed its integrity check (wrong key or altered data)",
      "tampered",
    );
  }
}

export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;
