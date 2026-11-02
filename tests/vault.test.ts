import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-vault-"));
const dbFile = path.join(dir, "db.sqlite");
const keyFile = path.join(dir, "keys", "vault.keys.json");
process.env.DATABASE_PATH = dbFile;
process.env.POSTBOX_VAULT_KEY_FILE = keyFile;
delete process.env.POSTBOX_VAULT_KEY;
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const vault = await import("@/server/vault");
const keys = await import("@/server/vault-keys");
const context = await import("@/server/context");
const backup = await import("@/server/backup");
const dbm = await import("@/server/db");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { queryAudit } = await import("@/server/audit");
const listRoute = await import("@/app/api/vault/route");
const oneRoute = await import("@/app/api/vault/[id]/route");
const migrateRoute = await import("@/app/api/vault/migrate/route");
const statusRoute = await import("@/app/api/admin/vault/route");
const rotateRoute = await import("@/app/api/admin/vault/rotate/route");
const codegenRoute = await import("@/app/api/codegen/route");

const SECRET = "sk_live_7f3a9c2e41d85b60aa11";
let target: TestServer;
let owner: UserRow, admin: UserRow, viewer: UserRow, outsider: UserRow;
const tokens: Record<string, string> = {};
let workspaceId = "";
let colA = "";
let colB = "";
const caller = (u: UserRow): Caller => ({ kind: "user", user: u, via: "token" });
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> | Response;
const call = async (
  handler: unknown,
  user: UserRow,
  url: string,
  init: { method?: string; body?: unknown; id?: string } = {},
) => {
  const res = await (handler as Handler)(
    new Request(`http://localhost${url}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${tokens[user.id]}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve({ id: init.id ?? "" }) },
  );
  const text = await res.text();
  return { status: res.status, text, data: text ? JSON.parse(text) : undefined };
};

const request = (over: Partial<RequestDef> = {}): RequestDef => ({
  id: "r",
  name: "r",
  method: "GET",
  url: `${target.url}/echo`,
  params: [],
  headers: [{ key: "X-Key", value: "{{vault:api}}", enabled: true }],
  body: { mode: "none" },
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...over,
});
const send = (folderId: string, req: RequestDef) =>
  withCaller(caller(owner), () =>
    context.runSingleRequest({ workspaceId, environmentId: null, folderId, request: req, requestId: null }),
  );
const lastHeader = (name: string) => String(target.requests.at(-1)?.headers[name] ?? "");

beforeAll(async () => {
  target = await startTestServer();
  owner = await users.createUser({ username: "owner", password: "password123" });
  admin = await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const u of [owner, admin, viewer, outsider]) tokens[u.id] = users.createToken(u.id, "t").token;
  withCaller(caller(owner), () => {
    workspaceId = repo.createWorkspace("Vault").id;
    setMember(workspaceId, viewer.username, "viewer");
    colA = repo.createFolder(workspaceId, null, { name: "A" }).id;
    colB = repo.createFolder(workspaceId, null, { name: "B" }).id;
  });
});
afterAll(async () => {
  await target.close();
  dbm.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const create = (extra: Record<string, unknown> = {}, user = owner) =>
  call(listRoute.POST, user, "/api/vault", {
    method: "POST",
    body: { workspaceId, name: "api", value: SECRET, ...extra },
  });

describe("storing secrets", () => {
  it("creates the key lazily outside the database and stores only ciphertext", async () => {
    expect(fs.existsSync(keyFile)).toBe(false);
    // Looking at an empty vault, even as an administrator, creates nothing.
    expect(vault.vaultStatus()).toMatchObject({ currentKeyId: null, secrets: 0 });
    expect(vault.listSecrets(workspaceId)).toEqual([]);
    expect(fs.existsSync(keyFile)).toBe(false);
    const res = await create({ description: "Payments API key" });
    expect(res.status, res.text).toBe(201);
    expect(res.text).not.toContain(SECRET);
    expect(res.data).toMatchObject({
      name: "api",
      state: "ok",
      reference: "{{vault:api}}",
      scriptAccess: false,
      collectionIds: [],
    });
    expect(fs.existsSync(keyFile)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const keyText = fs.readFileSync(keyFile, "utf8");
    dbm.getSqlite().pragma("wal_checkpoint(TRUNCATE)");
    const database = fs.readFileSync(dbFile).toString("latin1");
    expect(database).not.toContain(SECRET);
    for (const key of Object.values((JSON.parse(keyText) as { keys: Record<string, string> }).keys))
      expect(database).not.toContain(key);
    const stored = dbm.getSqlite().prepare("SELECT ciphertext, key_id FROM vault_secrets").get() as {
      ciphertext: string;
      key_id: string;
    };
    expect(stored.ciphertext).toMatch(/^v1\./);
    expect(stored.key_id).toBe(keys.getKeys().ring.current.id);
  });

  it("never returns values from any read", async () => {
    const list = await call(listRoute.GET, owner, `/api/vault?workspaceId=${workspaceId}`);
    const id = list.data[0].id as string;
    const one = await call(oneRoute.GET, owner, `/api/vault/${id}`, { id });
    for (const text of [list.text, one.text, JSON.stringify(vault.vaultStatus())]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("ciphertext");
    }
  });

  it("validates names, size, duplicates and collection scope", async () => {
    expect((await create({ name: "has space" })).status).toBe(400);
    expect((await create({ name: "x", value: "" })).status).toBe(400);
    expect((await create({ name: "x", value: "v".repeat(20000) })).status).toBe(400);
    expect((await create({ name: "x", unknown: 1 })).status).toBe(400);
    expect((await create({ name: "api" })).status).toBe(409);
    expect((await create({ name: "scoped", collectionIds: ["missing"] })).status).toBe(404);
  });

  it("lets viewers read metadata but not change anything, and hides the vault from outsiders", async () => {
    const id = vault.listSecrets(workspaceId)[0].id;
    expect((await call(listRoute.GET, viewer, `/api/vault?workspaceId=${workspaceId}`)).status).toBe(200);
    expect((await create({ name: "v" }, viewer)).status).toBe(403);
    expect(
      (await call(oneRoute.PATCH, viewer, `/api/vault/${id}`, { method: "PATCH", body: { value: "x" }, id }))
        .status,
    ).toBe(403);
    expect((await call(oneRoute.DELETE, viewer, `/api/vault/${id}`, { method: "DELETE", id })).status).toBe(
      403,
    );
    expect((await call(listRoute.GET, outsider, `/api/vault?workspaceId=${workspaceId}`)).status).toBe(404);
    expect((await call(oneRoute.GET, outsider, `/api/vault/${id}`, { id })).status).toBe(404);
    expect(
      (await call(migrateRoute.POST, viewer, "/api/vault/migrate", { method: "POST", body: { workspaceId } }))
        .status,
    ).toBe(403);
    expect((await call(statusRoute.GET, owner, "/api/admin/vault")).status).toBeGreaterThanOrEqual(403);
    expect(
      (await call(rotateRoute.POST, owner, "/api/admin/vault/rotate", { method: "POST", body: {} })).status,
    ).toBeGreaterThanOrEqual(403);
  });
});

describe("using secrets", () => {
  it("resolves {{vault:name}} when sending and redacts it from what is recorded", async () => {
    const result = await send(colA, request());
    expect(result.error).toBeUndefined();
    expect(lastHeader("x-key")).toBe(SECRET);
    expect(result.unresolved).toEqual([]);
    expect(JSON.stringify(result.sent)).not.toContain(SECRET);
    const history = JSON.stringify(repo.listHistory(workspaceId));
    expect(history).not.toContain(SECRET);
  });

  it("leaves an unknown reference unresolved instead of sending a guess", async () => {
    const result = await send(
      colA,
      request({ headers: [{ key: "X-Key", value: "{{vault:nope}}", enabled: true }] }),
    );
    expect(result.unresolved).toContain("vault:nope");
    expect(lastHeader("x-key")).toBe("{{vault:nope}}");
  });

  it("limits a secret to the collections it is scoped to", async () => {
    const scoped = await create({ name: "only-a", collectionIds: [colA] });
    expect(scoped.status).toBe(201);
    const req = request({ headers: [{ key: "X-Key", value: "{{vault:only-a}}", enabled: true }] });
    await send(colA, req);
    expect(lastHeader("x-key")).toBe(SECRET);
    const other = await send(colB, req);
    expect(other.unresolved).toContain("vault:only-a");
    expect(lastHeader("x-key")).toBe("{{vault:only-a}}");
  });

  it("gives scripts only the secrets marked for script access", async () => {
    const script = `pm.request.headers.add({ key: "X-Seen", value: String(pm.vault.get("api")) }); pm.request.headers.add({ key: "X-Has", value: String(pm.vault.has("api")) });`;
    const first = await send(colA, request({ preRequestScript: script }));
    expect(first.scriptErrors).toEqual([]);
    expect(lastHeader("x-seen")).toBe("undefined");
    expect(lastHeader("x-has")).toBe("false");
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    expect(
      (
        await call(oneRoute.PATCH, owner, `/api/vault/${id}`, {
          method: "PATCH",
          body: { scriptAccess: true },
          id,
        })
      ).data.scriptAccess,
    ).toBe(true);
    await send(colA, request({ preRequestScript: script }));
    expect(lastHeader("x-seen")).toBe(SECRET);
    expect(lastHeader("x-has")).toBe("true");
  });

  it("never exposes the vault as a variable scope", async () => {
    const script = `const all = JSON.stringify([pm.variables.toObject(), pm.environment.toObject(), pm.globals.toObject(), pm.collectionVariables.toObject(), pm.variables.get("vault:api"), pm.variables.replaceIn("{{vault:api}}")]);
      pm.request.headers.add({ key: "X-Dump", value: all.replace(/[{}]/g, "_") });`;
    await send(colA, request({ preRequestScript: script }));
    expect(lastHeader("x-dump")).not.toContain(SECRET);
    expect(lastHeader("x-dump")).toContain("__vault:api__");
  });

  it("resolves references inside pm.sendRequest", async () => {
    const script = `pm.sendRequest({ url: "${target.url}/echo", method: "GET", header: [{ key: "X-Inner", value: "{{vault:api}}" }] }, function () {});`;
    await send(colA, request({ preRequestScript: script }));
    const inner = target.requests.find((r) => r.headers["x-inner"]);
    expect(inner?.headers["x-inner"]).toBe(SECRET);
  });

  it("keeps decrypted values out of generated code snippets", async () => {
    const res = await codegenRoute.POST(
      new Request("http://localhost/api/codegen", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[owner.id]}`, "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          folderId: colA,
          request: {
            name: "x",
            method: "GET",
            url: "https://example.test/",
            headers: [{ key: "X-Key", value: "{{vault:api}}", enabled: true }],
          },
          language: "curl",
          options: {},
        }),
      }),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("vault:api");
  });
});

describe("renaming, rotating and deleting", () => {
  it("re-encrypts on rename and refuses a value moved between secrets", async () => {
    const a = (await create({ name: "swap-a", value: "value-a-123" })).data.id as string;
    const b = (await create({ name: "swap-b", value: "value-b-456" })).data.id as string;
    const renamed = await call(oneRoute.PATCH, owner, `/api/vault/${a}`, {
      method: "PATCH",
      body: { name: "swap-a2" },
      id: a,
    });
    expect(renamed.data).toMatchObject({ name: "swap-a2", state: "ok" });
    expect(vault.loadVaultForExecution(workspaceId, null).values["swap-a2"]).toBe("value-a-123");
    // Copy one ciphertext over the other by hand: the name is authenticated, so neither decrypts.
    const sql = dbm.getSqlite();
    const ca = (
      sql.prepare("SELECT ciphertext FROM vault_secrets WHERE id = ?").get(a) as { ciphertext: string }
    ).ciphertext;
    sql.prepare("UPDATE vault_secrets SET ciphertext = ? WHERE id = ?").run(ca, b);
    const loaded = vault.loadVaultForExecution(workspaceId, null).values;
    expect(loaded["swap-b"]).toBeUndefined();
    expect(loaded["swap-a2"]).toBe("value-a-123");
    for (const id of [a, b]) vault.deleteSecret(id);
  });

  it("replaces a value without revealing the old one", async () => {
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    const before = vault.getSecret(id);
    const res = await call(oneRoute.PATCH, owner, `/api/vault/${id}`, {
      method: "PATCH",
      body: { value: "sk_live_rotated_value_99" },
      id,
    });
    expect(res.text).not.toContain("sk_live");
    expect(res.data.rotatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(vault.loadVaultForExecution(workspaceId, colA).values.api).toBe("sk_live_rotated_value_99");
    await call(oneRoute.PATCH, owner, `/api/vault/${id}`, { method: "PATCH", body: { value: SECRET }, id });
  });

  it("rotates keys: re-encrypts everything, keeps working, and prunes retired keys", async () => {
    const before = vault.vaultStatus();
    expect(before.keySource).toBe("file");
    const oldKeyId = before.currentKeyId;
    const rotated = await call(rotateRoute.POST, admin, "/api/admin/vault/rotate", {
      method: "POST",
      body: { newKey: true },
    });
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.data.currentKeyId).not.toBe(oldKeyId);
    expect(rotated.data.reencrypted).toBeGreaterThan(0);
    expect(rotated.data.unreadable).toEqual([]);
    const status = (await call(statusRoute.GET, admin, "/api/admin/vault")).data;
    expect(status.byKey).toEqual([
      { keyId: rotated.data.currentKeyId, secrets: status.secrets - status.needValue, available: true },
    ]);
    expect(status.availableKeyIds).toContain(oldKeyId);
    expect(JSON.stringify(status)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    await send(colA, request());
    expect(lastHeader("x-key")).toBe(SECRET);
    const pruned = await call(rotateRoute.POST, admin, "/api/admin/vault/rotate", {
      method: "POST",
      body: { prune: true },
    });
    expect(pruned.data.removedKeys).toEqual([oldKeyId]);
    expect(Object.keys((JSON.parse(fs.readFileSync(keyFile, "utf8")) as { keys: object }).keys)).toEqual([
      rotated.data.currentKeyId,
    ]);
    await send(colA, request());
    expect(lastHeader("x-key")).toBe(SECRET);
  });

  it("marks secrets unreadable when their key is gone and skips them at use", async () => {
    const made = (await create({ name: "orphan", value: "orphan-value-789" })).data.id as string;
    const fake = "ab".repeat(4);
    dbm
      .getSqlite()
      .prepare("UPDATE vault_secrets SET key_id = ?, ciphertext = replace(ciphertext, ?, ?) WHERE id = ?")
      .run(fake, keys.getKeys().ring.current.id, fake, made);
    expect(vault.getSecret(made).state).toBe("unreadable");
    expect(vault.loadVaultForExecution(workspaceId, null).values.orphan).toBeUndefined();
    const rotated = vault.rotateKeys();
    expect(rotated.unreadable).toEqual([`${workspaceId}/orphan`]);
    // Pruning is refused while a secret still needs an unavailable key.
    expect(vault.rotateKeys({ prune: true }).removedKeys).toEqual([]);
    vault.deleteSecret(made);
  });

  it("takes keys from the environment, with previous keys for values not yet re-encrypted", () => {
    const fileKey = Object.values(
      (JSON.parse(fs.readFileSync(keyFile, "utf8")) as { keys: Record<string, string> }).keys,
    )[0];
    const newKey = Buffer.alloc(32, 7).toString("base64");
    try {
      process.env.POSTBOX_VAULT_KEY = fileKey;
      expect(keys.getKeys().source).toBe("environment");
      expect(vault.vaultStatus()).toMatchObject({ keySource: "environment", keyFile: null });
      expect(() => keys.addKeyToFile()).toThrow(/POSTBOX_VAULT_KEY/);
      expect(vault.listSecrets(workspaceId).every((s) => s.state === "ok")).toBe(true);

      // A new environment key cannot read old values until the old key is listed as previous.
      process.env.POSTBOX_VAULT_KEY = newKey;
      expect(vault.listSecrets(workspaceId).every((s) => s.state === "unreadable")).toBe(true);
      process.env.POSTBOX_VAULT_PREVIOUS_KEYS = fileKey;
      expect(vault.listSecrets(workspaceId).every((s) => s.state === "ok")).toBe(true);
      const moved = vault.rotateKeys();
      expect(moved.reencrypted).toBeGreaterThan(0);
      expect(vault.vaultStatus().byKey).toHaveLength(1);
      expect(vault.vaultStatus().currentKeyId).toBe(keys.getKeys().ring.current.id);

      // And back again, so the rest of the suite uses the key file.
      process.env.POSTBOX_VAULT_KEY = fileKey;
      process.env.POSTBOX_VAULT_PREVIOUS_KEYS = newKey;
      expect(vault.rotateKeys().unreadable).toEqual([]);
    } finally {
      delete process.env.POSTBOX_VAULT_KEY;
      delete process.env.POSTBOX_VAULT_PREVIOUS_KEYS;
      keys.resetKeyCache();
    }
    expect(keys.getKeys().source).toBe("file");
    expect(vault.listSecrets(workspaceId).every((s) => s.state === "ok")).toBe(true);
  });
});

describe("migration, backup and audit", () => {
  it("moves secret variables into the vault and keeps requests working", async () => {
    const env = repo.createEnvironment(workspaceId, "Prod");
    repo.replaceVariables(workspaceId, "environment", env.id, [
      { key: "token", value: "env-token-value-111", type: "secret", enabled: true },
      { key: "region", value: "eu", type: "default", enabled: true },
    ]);
    repo.replaceVariables(workspaceId, "collection", colA, [
      { key: "dbpass", value: "col-secret-222", type: "secret", enabled: true },
    ]);
    const res = await call(migrateRoute.POST, owner, "/api/vault/migrate", {
      method: "POST",
      body: { workspaceId },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.text).not.toMatch(/env-token-value-111|col-secret-222/);
    expect(res.data.moved.map((m: { key: string }) => m.key).sort()).toEqual(["dbpass", "token"]);
    const envVars = repo.listVariables(workspaceId, "environment", env.id);
    expect(envVars.find((v) => v.key === "token")!.value).toMatch(/^\{\{vault:environment\.Prod\.token\}\}$/);
    expect(envVars.find((v) => v.key === "region")!.value).toBe("eu");
    expect(JSON.stringify(repo.listVariables(workspaceId, "collection", colA))).toContain(
      "{{vault:collection.",
    );
    // Still works end to end, and the collection variable stays scoped to its collection.
    const out = await withCaller(caller(owner), () =>
      context.runSingleRequest({
        workspaceId,
        environmentId: env.id,
        folderId: colA,
        request: request({
          headers: [
            { key: "X-Tok", value: "{{token}}", enabled: true },
            { key: "X-Db", value: "{{dbpass}}", enabled: true },
          ],
        }),
        requestId: null,
      }),
    );
    expect(out.unresolved).toEqual([]);
    expect(lastHeader("x-tok")).toBe("env-token-value-111");
    expect(lastHeader("x-db")).toBe("col-secret-222");
    await withCaller(caller(owner), () =>
      context.runSingleRequest({
        workspaceId,
        environmentId: env.id,
        folderId: colB,
        request: request({ headers: [{ key: "X-Tok", value: "{{token}}", enabled: true }] }),
        requestId: null,
      }),
    );
    expect(lastHeader("x-tok")).toBe("env-token-value-111");
    const again = await call(migrateRoute.POST, owner, "/api/vault/migrate", {
      method: "POST",
      body: { workspaceId },
    });
    expect(again.data.moved).toEqual([]);
    expect(again.data.skipped).toHaveLength(2);
  });

  it("backs up ciphertext with secrets, withholds it without them, and restores both", () => {
    const full = backup.createBackup(dbm.getDb(), { includeSecrets: true });
    const text = JSON.stringify(full.tables.vaultSecrets);
    expect(text).toContain("v1.");
    expect(text).not.toContain(SECRET);
    const scrubbed = backup.createBackup(dbm.getDb(), { includeSecrets: false });
    expect(JSON.stringify(scrubbed.tables.vaultSecrets)).not.toContain("v1.");
    expect(scrubbed.tables.vaultSecrets.length).toBe(full.tables.vaultSecrets.length);
    // A key file is never part of a backup.
    expect(JSON.stringify(full)).not.toContain(
      Object.values(
        (JSON.parse(fs.readFileSync(keyFile, "utf8")) as { keys: Record<string, string> }).keys,
      )[0],
    );

    backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(scrubbed)));
    const states = vault.listSecrets(workspaceId).map((s) => s.state);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === "needs-value")).toBe(true);
    expect(vault.vaultStatus().needValue).toBe(states.length);
    expect(vault.loadVaultForExecution(workspaceId, colA).values).toEqual({});
    // A secret that lost its value can be given one again.
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    vault.updateSecret(id, { value: SECRET });
    expect(vault.getSecret(id).state).toBe("ok");

    backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(full)));
    expect(vault.listSecrets(workspaceId).every((s) => s.state === "ok")).toBe(true);
    expect(vault.loadVaultForExecution(workspaceId, colA).values.api).toBe(SECRET);
  });

  it("audits changes without values", () => {
    const events = queryAudit({ workspaceId, limit: 500 } as never) as unknown as {
      events: { action: string }[];
    };
    const text = JSON.stringify(events);
    expect(text).toContain("vaultSecret");
    expect(text).toContain("vault.migrate");
    expect(text).not.toMatch(
      new RegExp(`${SECRET}|sk_live_rotated|orphan-value|env-token-value|v1\\.[0-9a-f]{8}`),
    );
  });
});
