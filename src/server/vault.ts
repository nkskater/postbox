/**
 * The secrets vault: encrypted values with scoped access. Values are write-only through every API; they leave the
 * database only decrypted into an execution (as {{vault:name}} references and, where allowed, pm.vault.get()).
 * The key is held outside the database and backups (src/server/vault-keys.ts).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { credentialRedactionValues } from "@/core/retention";
import {
  MAX_SECRET_BYTES,
  SECRET_NAME,
  VaultCryptoError,
  decryptSecret,
  encryptSecret,
  keyIdOfCiphertext,
} from "@/core/vault/crypto";
import { audit } from "./audit";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { actorId } from "./authorize";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";
import { addKeyToFile, getKeys, keysExist, pruneFileKeys } from "./vault-keys";

const { vaultSecrets, variables } = schema;
export const MAX_SECRETS_PER_WORKSPACE = 500;

const bad = (message: string) => new HttpError(400, message);

export const secretInput = z
  .object({
    name: z
      .string()
      .regex(SECRET_NAME, "Names are 1-64 letters, digits, '_', '.' or '-', starting with a letter or digit"),
    value: z.string().min(1).max(MAX_SECRET_BYTES),
    description: z.string().max(500).optional(),
    scriptAccess: z.boolean().optional(),
    collectionIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();
export const secretPatch = secretInput.partial().strict();

export interface SecretView {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  keyId: string;
  scriptAccess: boolean;
  collectionIds: string[];
  /** ok | needs-value (a backup withheld it) | unreadable (its key is not available) */
  state: "ok" | "needs-value" | "unreadable";
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
  /** The reference to use in requests. */
  reference: string;
}

type Row = typeof vaultSecrets.$inferSelect;

function view(row: Row): SecretView {
  const ring = getKeys().ring;
  const state = !row.ciphertext ? "needs-value" : ring.all.has(row.keyId) ? "ok" : "unreadable";
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    keyId: row.keyId,
    scriptAccess: row.scriptAccess,
    collectionIds: row.collectionIds,
    state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rotatedAt: row.rotatedAt,
    reference: `{{vault:${row.name}}}`,
  };
}

const row = (id: string) => {
  const found = getDb().select().from(vaultSecrets).where(eq(vaultSecrets.id, id)).get();
  if (!found) throw notFound("Secret");
  return found;
};

function checkCollections(workspaceId: string, ids: string[]) {
  for (const id of ids) repo.requireCollectionIn(workspaceId, id);
}

export function listSecrets(workspaceId: string): SecretView[] {
  repo.requireWorkspace(workspaceId);
  const rows = getDb().select().from(vaultSecrets).where(eq(vaultSecrets.workspaceId, workspaceId)).all();
  if (!rows.length) return [];
  return rows.sort((a, b) => a.name.localeCompare(b.name)).map(view);
}

export function getSecret(id: string): SecretView {
  return view(row(id));
}

export function createSecret(workspaceId: string, raw: z.input<typeof secretInput>): SecretView {
  repo.requireWorkspace(workspaceId);
  const input = secretInput.parse(raw);
  const db = getDb();
  if (
    db.select().from(vaultSecrets).where(eq(vaultSecrets.workspaceId, workspaceId)).all().length >=
    MAX_SECRETS_PER_WORKSPACE
  )
    throw bad(`A workspace can hold at most ${MAX_SECRETS_PER_WORKSPACE} secrets`);
  if (
    db
      .select()
      .from(vaultSecrets)
      .where(and(eq(vaultSecrets.workspaceId, workspaceId), eq(vaultSecrets.name, input.name)))
      .get()
  )
    throw new HttpError(409, `A secret named "${input.name}" already exists`);
  checkCollections(workspaceId, input.collectionIds ?? []);
  const { ciphertext, keyId } = encryptSecret(getKeys().ring, workspaceId, input.name, input.value);
  const now = Date.now();
  const record: Row = {
    id: newId(),
    workspaceId,
    name: input.name,
    description: input.description ?? "",
    ciphertext,
    keyId,
    scriptAccess: input.scriptAccess ?? false,
    collectionIds: input.collectionIds ?? [],
    createdBy: actorId(),
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
  };
  db.insert(vaultSecrets).values(record).run();
  return view(record);
}

export function updateSecret(id: string, raw: z.input<typeof secretPatch>): SecretView {
  const patch = secretPatch.parse(raw);
  const current = row(id);
  const db = getDb();
  const ring = getKeys().ring;
  const name = patch.name ?? current.name;
  if (
    name !== current.name &&
    db
      .select()
      .from(vaultSecrets)
      .where(and(eq(vaultSecrets.workspaceId, current.workspaceId), eq(vaultSecrets.name, name)))
      .get()
  )
    throw new HttpError(409, `A secret named "${name}" already exists`);
  if (patch.collectionIds) checkCollections(current.workspaceId, patch.collectionIds);
  const set: Partial<Row> = { updatedAt: Date.now() };
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.scriptAccess !== undefined) set.scriptAccess = patch.scriptAccess;
  if (patch.collectionIds) set.collectionIds = patch.collectionIds;
  if (patch.value !== undefined || name !== current.name) {
    // The name is authenticated with the value, so a rename re-encrypts it.
    let value = patch.value;
    if (value === undefined) {
      if (!current.ciphertext)
        throw bad("This secret has no value yet; provide one together with the new name");
      value = readValue(ring, current);
    }
    Object.assign(set, encryptSecret(ring, current.workspaceId, name, value), {
      name,
      rotatedAt: Date.now(),
    });
  }
  db.update(vaultSecrets).set(set).where(eq(vaultSecrets.id, id)).run();
  return view(row(id));
}

export function deleteSecret(id: string) {
  row(id);
  getDb().delete(vaultSecrets).where(eq(vaultSecrets.id, id)).run();
}

function readValue(ring: ReturnType<typeof getKeys>["ring"], r: Row): string {
  try {
    return decryptSecret(ring, r.workspaceId, r.name, r.ciphertext);
  } catch (error) {
    if (error instanceof VaultCryptoError) throw new HttpError(409, `Secret "${r.name}": ${error.message}`);
    throw error;
  }
}

export interface VaultForExecution {
  values: Record<string, string>;
  scriptNames: string[];
  /** Values (and encoded forms) to redact from anything that is logged or stored. */
  secrets: string[];
}

/**
 * Decrypt what an execution under `collectionId` may reference. Secrets that cannot be read (withheld value, missing
 * key) are left out, so their references show up as unresolved instead of failing the run.
 */
export function loadVaultForExecution(workspaceId: string, collectionId: string | null): VaultForExecution {
  const rows = getDb().select().from(vaultSecrets).where(eq(vaultSecrets.workspaceId, workspaceId)).all();
  const out: VaultForExecution = { values: {}, scriptNames: [], secrets: [] };
  if (!rows.length) return out;
  const ring = getKeys().ring;
  for (const r of rows) {
    if (!r.ciphertext) continue;
    if (r.collectionIds.length && (!collectionId || !r.collectionIds.includes(collectionId))) continue;
    try {
      const value = decryptSecret(ring, workspaceId, r.name, r.ciphertext);
      out.values[r.name] = value;
      if (r.scriptAccess) out.scriptNames.push(r.name);
      out.secrets.push(value);
    } catch {
      /* unreadable: reported by the vault page, unresolved at use */
    }
  }
  out.secrets = credentialRedactionValues(out.secrets);
  return out;
}

// ---- keys ---------------------------------------------------------------------------------------

export interface VaultStatus {
  keySource: "environment" | "file";
  /** Only the file name, never its contents. */
  keyFile: string | null;
  /** Null until the first secret is stored (the key is created then). */
  currentKeyId: string | null;
  availableKeyIds: string[];
  secrets: number;
  /** Secrets per key id; ids that are not available are unreadable. */
  byKey: { keyId: string; secrets: number; available: boolean }[];
  needValue: number;
}

export function vaultStatus(): VaultStatus {
  if (!keysExist())
    return {
      keySource: "file",
      keyFile: null,
      currentKeyId: null,
      availableKeyIds: [],
      secrets: 0,
      byKey: [],
      needValue: 0,
    };
  const keys = getKeys();
  const rows = getDb().select().from(vaultSecrets).all();
  const counts = new Map<string, number>();
  let needValue = 0;
  for (const r of rows) {
    if (!r.ciphertext) needValue++;
    else counts.set(r.keyId, (counts.get(r.keyId) ?? 0) + 1);
  }
  return {
    keySource: keys.source,
    keyFile: keys.file,
    currentKeyId: keys.ring.current.id,
    availableKeyIds: [...keys.ring.all.keys()],
    secrets: rows.length,
    byKey: [...counts].map(([keyId, secrets]) => ({ keyId, secrets, available: keys.ring.all.has(keyId) })),
    needValue,
  };
}

/**
 * Re-encrypt every readable secret under the current key; with `newKey`, first make a new key (file-managed keys
 * only). `prune` then removes keys from the key file that no secret uses any more.
 */
export function rotateKeys(opts: { newKey?: boolean; prune?: boolean } = {}) {
  let keys = getKeys();
  if (opts.newKey) keys = addKeyToFile();
  const db = getDb();
  let reencrypted = 0;
  const unreadable: string[] = [];
  db.transaction((tx) => {
    for (const r of tx.select().from(vaultSecrets).all()) {
      if (!r.ciphertext || keyIdOfCiphertext(r.ciphertext) === keys.ring.current.id) continue;
      try {
        const value = decryptSecret(keys.ring, r.workspaceId, r.name, r.ciphertext);
        const next = encryptSecret(keys.ring, r.workspaceId, r.name, value);
        tx.update(vaultSecrets)
          .set({ ...next, rotatedAt: Date.now() })
          .where(eq(vaultSecrets.id, r.id))
          .run();
        reencrypted++;
      } catch {
        unreadable.push(`${r.workspaceId}/${r.name}`);
      }
    }
  });
  let removedKeys: string[] = [];
  if (opts.prune && !unreadable.length) {
    const inUse = new Set(
      db
        .select()
        .from(vaultSecrets)
        .all()
        .map((r) => r.keyId),
    );
    removedKeys = pruneFileKeys(inUse);
  }
  audit({
    action: "vault.rotate",
    entityKind: "other",
    entityName: "Secrets vault",
    changes: [
      { field: "keyId", before: null, after: keys.ring.current.id },
      { field: "reencrypted", before: 0, after: reencrypted },
    ],
  });
  return { currentKeyId: keys.ring.current.id, reencrypted, unreadable, removedKeys };
}

// ---- migration of plaintext secret variables ---------------------------------------------------------

const slug = (text: string) =>
  text
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40) || "x";

/**
 * Move the values of secret-type variables into the vault and replace each with a `{{vault:name}}` reference.
 * Variables already holding a reference, and empty ones, are skipped.
 */
export function migrateSecretVariables(workspaceId: string, opts: { scriptAccess?: boolean } = {}) {
  repo.requireWorkspace(workspaceId);
  const db = getDb();
  const ring = getKeys().ring;
  const names = new Set(
    db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.workspaceId, workspaceId))
      .all()
      .map((r) => r.name),
  );
  const moved: { scope: string; key: string; name: string }[] = [];
  const skipped: { scope: string; key: string; reason: string }[] = [];
  const environments = new Map(repo.listEnvironments(workspaceId).map((e) => [e.id, e.name]));
  const rows = db
    .select()
    .from(variables)
    .where(and(eq(variables.workspaceId, workspaceId), eq(variables.type, "secret")))
    .all();
  db.transaction((tx) => {
    for (const v of rows) {
      if (!v.value) continue;
      if (/^\{\{\s*vault:[^{}]+\}\}$/.test(v.value)) {
        skipped.push({ scope: v.scope, key: v.key, reason: "already a vault reference" });
        continue;
      }
      if (Buffer.byteLength(v.value) > MAX_SECRET_BYTES) {
        skipped.push({ scope: v.scope, key: v.key, reason: "value is too large for the vault" });
        continue;
      }
      if (names.size >= MAX_SECRETS_PER_WORKSPACE) {
        skipped.push({ scope: v.scope, key: v.key, reason: "the workspace vault is full" });
        continue;
      }
      const owner =
        v.scope === "environment"
          ? environments.get(v.ownerId ?? "")
          : v.scope === "collection"
            ? v.ownerId
            : null;
      const base = [v.scope === "global" ? "global" : v.scope, owner ? slug(owner) : null, slug(v.key)]
        .filter(Boolean)
        .join(".")
        .slice(0, 60);
      let name = base;
      for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
      names.add(name);
      const now = Date.now();
      tx.insert(vaultSecrets)
        .values({
          id: newId(),
          workspaceId,
          name,
          description: `Moved from the ${v.scope} variable "${v.key}"`,
          ...encryptSecret(ring, workspaceId, name, v.value),
          scriptAccess: opts.scriptAccess ?? false,
          // A collection variable stays usable only within its collection.
          collectionIds: v.scope === "collection" && v.ownerId ? [v.ownerId] : [],
          createdBy: actorId(),
          createdAt: now,
          updatedAt: now,
          rotatedAt: null,
        })
        .run();
      tx.update(variables)
        .set({ value: `{{vault:${name}}}` })
        .where(eq(variables.id, v.id))
        .run();
      moved.push({ scope: v.scope, key: v.key, name });
    }
  });
  audit({
    action: "vault.migrate",
    entityKind: "other",
    entityName: "Secrets vault",
    workspaceId,
    changes: [{ field: "movedVariables", before: 0, after: moved.length }],
  });
  return { moved, skipped };
}
