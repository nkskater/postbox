/**
 * Moving vault secrets between servers: a passphrase-protected file (scrypt-derived AES-256-GCM key), or plaintext
 * when explicitly asked for. Collections are carried by name because ids differ between servers. Pure.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { VaultCryptoError, SECRET_NAME } from "./crypto";

export const EXPORT_FORMAT = "postbox.vault";
export const MIN_PASSPHRASE = 8;
const KDF = { N: 32768, r: 8, p: 1 };
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const exportedSecretSchema = z.object({
  name: z.string().regex(SECRET_NAME),
  value: z
    .string()
    .min(1)
    .max(16 * 1024),
  description: z.string().max(500).default(""),
  scriptAccess: z.boolean().default(false),
  enabled: z.boolean().default(true),
  domains: z.array(z.string().max(253)).max(20).default([]),
  /** Collection names the secret was limited to; empty means the whole workspace. */
  collections: z.array(z.string().max(200)).max(100).default([]),
  personal: z.boolean().default(false),
});
export type ExportedSecret = z.infer<typeof exportedSecretSchema>;
const payloadSchema = z.object({ secrets: z.array(exportedSecretSchema).max(2000) });

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  encrypted: boolean;
  exportedAt: string;
  // encrypted files
  kdf?: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  nonce?: string;
  ciphertext?: string;
  // plaintext files
  secrets?: ExportedSecret[];
}

const derive = (passphrase: string, salt: Buffer, n = KDF.N, r = KDF.r, p = KDF.p) =>
  scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: n, r, p, maxmem: 128 * 1024 * 1024 });

export function sealExport(secrets: ExportedSecret[], passphrase: string): ExportFile {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new VaultCryptoError(`The passphrase needs at least ${MIN_PASSPHRASE} characters`, "bad-key");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt), nonce);
  cipher.setAAD(Buffer.from(EXPORT_FORMAT));
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ secrets }), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    format: EXPORT_FORMAT,
    version: 1,
    encrypted: true,
    exportedAt: new Date().toISOString(),
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64url") },
    nonce: nonce.toString("base64url"),
    ciphertext: body.toString("base64url"),
  };
}

export function plainExport(secrets: ExportedSecret[]): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    encrypted: false,
    exportedAt: new Date().toISOString(),
    secrets,
  };
}

const fileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  encrypted: z.boolean(),
  exportedAt: z.string().optional(),
  kdf: z
    .object({
      name: z.literal("scrypt"),
      N: z.number().int(),
      r: z.number().int(),
      p: z.number().int(),
      salt: z.string(),
    })
    .optional(),
  nonce: z.string().optional(),
  ciphertext: z.string().optional(),
  secrets: z.array(z.unknown()).optional(),
});

/** Read an export file. Wrong passphrases and damaged files both report as `tampered`. */
export function openExport(input: unknown, passphrase?: string): ExportedSecret[] {
  if (JSON.stringify(input ?? null).length > MAX_FILE_BYTES)
    throw new VaultCryptoError("The file is too large", "malformed");
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) throw new VaultCryptoError("This is not a Postbox vault export", "malformed");
  const file = parsed.data;
  if (!file.encrypted) return payloadSchema.parse({ secrets: file.secrets ?? [] }).secrets;
  if (!passphrase) throw new VaultCryptoError("This export is encrypted: provide its passphrase", "bad-key");
  if (!file.kdf || !file.nonce || !file.ciphertext)
    throw new VaultCryptoError("The export is incomplete", "malformed");
  // Cost parameters come from the file, so bound them: a hostile file must not make the server do unbounded work.
  const { N, r, p } = file.kdf;
  if (N < 1024 || N > 1 << 17 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4)
    throw new VaultCryptoError("The export uses unsupported key-derivation settings", "malformed");
  const body = Buffer.from(file.ciphertext, "base64url");
  if (body.length < 17) throw new VaultCryptoError("The export is truncated", "malformed");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(passphrase, Buffer.from(file.kdf.salt, "base64url"), N, r, p),
      Buffer.from(file.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(EXPORT_FORMAT));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const text = Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return payloadSchema.parse(JSON.parse(text)).secrets;
  } catch {
    throw new VaultCryptoError("Wrong passphrase, or the file was changed", "tampered");
  }
}
