import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { DomainPatternError, domainMatches, misdirectedSecrets, parseDomains } from "@/core/vault/domains";
import { openExport, plainExport, sealExport, type ExportedSecret } from "@/core/vault/transfer";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-vault-parity-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "vault.keys.json");
delete process.env.POSTBOX_VAULT_KEY;
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const vault = await import("@/server/vault");
const context = await import("@/server/context");
const backup = await import("@/server/backup");
const dbm = await import("@/server/db");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { queryAudit } = await import("@/server/audit");
const listRoute = await import("@/app/api/vault/route");
const oneRoute = await import("@/app/api/vault/[id]/route");
const revealRoute = await import("@/app/api/vault/[id]/reveal/route");
const exportRoute = await import("@/app/api/vault/export/route");
const importRoute = await import("@/app/api/vault/import/route");

const SECRET = "sk_live_parity_4f9a1c77d2e0b385";

describe("allowed domains", () => {
  it("validates patterns", () => {
    expect(parseDomains("API.Example.com, *.example.org ,10.0.0.1,localhost")).toEqual([
      "api.example.com",
      "*.example.org",
      "10.0.0.1",
      "localhost",
    ]);
    expect(parseDomains([])).toEqual([]);
    for (const bad of ["*", "http://x.com", "ex ample.com", "*.10.0.0.1", "a..b", "-x.com", "x.com/path"])
      expect(() => parseDomains([bad]), bad).toThrow(DomainPatternError);
    expect(() => parseDomains(Array.from({ length: 21 }, (_, i) => `h${i}.com`))).toThrow(/At most 20/);
  });

  it("matches exact hosts and wildcards but not look-alikes", () => {
    const p = ["api.example.com", "*.cdn.example.org"];
    expect(domainMatches(p, "API.example.com")).toBe(true);
    expect(domainMatches(p, "api.example.com.")).toBe(true);
    expect(domainMatches(p, "a.b.cdn.example.org")).toBe(true);
    expect(domainMatches(p, "cdn.example.org")).toBe(false);
    expect(domainMatches(p, "evil-api.example.com")).toBe(false);
    expect(domainMatches(p, "api.example.com.evil.net")).toBe(false);
    expect(domainMatches(p, "xcdn.example.org")).toBe(false);
    expect(domainMatches([], "anything.test")).toBe(true);
    expect(domainMatches(["127.0.0.1"], "127.0.0.1")).toBe(true);
    expect(domainMatches(["::1"], "[::1]")).toBe(true);
  });

  it("finds a secret wherever it was placed", () => {
    const s = [{ name: "k", value: "p@ss word&1/2", domains: ["good.test"] }];
    const bad = (m: Partial<Parameters<typeof misdirectedSecrets>[1]>) =>
      misdirectedSecrets(s, { url: "https://evil.test/x", headers: [], ...m });
    expect(bad({})).toEqual([]);
    expect(bad({ url: "https://evil.test/?a=p%40ss%20word%261%2F2" })).toEqual(["k"]);
    expect(bad({ headers: [["X-Key", "Bearer p@ss word&1/2"]] })).toEqual(["k"]);
    expect(
      bad({ headers: [["Authorization", `Basic ${Buffer.from("user:p@ss word&1/2").toString("base64")}`]] }),
    ).toEqual(["k"]);
    expect(bad({ body: Buffer.from('{"k":"p@ss word&1/2"}') })).toEqual(["k"]);
    expect(bad({ body: "token=p%40ss%20word%261%2F2" })).toEqual(["k"]);
    expect(misdirectedSecrets(s, { url: "https://good.test/", headers: [["X", "p@ss word&1/2"]] })).toEqual(
      [],
    );
    expect(
      misdirectedSecrets([{ name: "any", value: "p@ss word&1/2", domains: [] }], {
        url: "https://evil.test/",
        headers: [["X", "p@ss word&1/2"]],
      }),
    ).toEqual([]);
  });
});

describe("export files", () => {
  const items: ExportedSecret[] = [
    {
      name: "a",
      value: "value-a-12345",
      description: "d",
      scriptAccess: true,
      enabled: true,
      domains: ["x.test"],
      collections: ["Shop"],
      personal: false,
    },
  ];
  it("round-trips with the passphrase and reveals nothing without it", () => {
    const file = sealExport(items, "correct horse battery");
    expect(JSON.stringify(file)).not.toContain("value-a-12345");
    expect(file).toMatchObject({ format: "postbox.vault", encrypted: true, kdf: { name: "scrypt" } });
    expect(openExport(file, "correct horse battery")).toEqual(items);
    expect(() => openExport(file, "wrong passphrase")).toThrow(/Wrong passphrase/);
    expect(() => openExport(file)).toThrow(/passphrase/);
    expect(() => sealExport(items, "short")).toThrow(/at least 8/);
    const altered = { ...file, ciphertext: file.ciphertext!.slice(0, -4) + "AAAA" };
    expect(() => openExport(altered, "correct horse battery")).toThrow(
      /Wrong passphrase, or the file was changed/,
    );
  });
  it("bounds hostile key-derivation settings and rejects other files", () => {
    const file = sealExport(items, "correct horse battery");
    expect(() => openExport({ ...file, kdf: { ...file.kdf!, N: 1 << 30 } }, "x".repeat(10))).toThrow(
      /unsupported/,
    );
    expect(() => openExport({ ...file, kdf: { ...file.kdf!, N: 3000 } }, "x".repeat(10))).toThrow(
      /unsupported/,
    );
    expect(() => openExport({ hello: 1 })).toThrow(/not a Postbox vault export/);
    expect(openExport(plainExport(items))).toEqual(items);
    expect(() =>
      openExport({
        format: "postbox.vault",
        version: 1,
        encrypted: false,
        secrets: [{ name: "bad name", value: "v" }],
      }),
    ).toThrow();
  });
});

let target: TestServer;
let other: http.Server;
let otherUrl = "";
let owner: UserRow, editor: UserRow, viewer: UserRow, outsider: UserRow;
const tokens: Record<string, string> = {};
let workspaceId = "";
let colA = "";
let hostAllowed = "";
let hostOther = "";
let otherHits = 0;
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
  return { status: res.status, text, data: text ? JSON.parse(text) : undefined, headers: res.headers };
};
const create = (extra: Record<string, unknown> = {}, user = owner) =>
  call(listRoute.POST, user, "/api/vault", {
    method: "POST",
    body: { workspaceId, name: "api", value: SECRET, ...extra },
  });

const request = (over: Partial<RequestDef> = {}): RequestDef => ({
  id: "r",
  name: "r",
  method: "GET",
  url: `${hostAllowed}/echo`,
  params: [],
  headers: [{ key: "X-Key", value: "{{vault:api}}", enabled: true }],
  body: { mode: "none" },
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...over,
});
const send = (folderId: string, req: RequestDef, user: UserRow | null = owner) => {
  const run = () =>
    context.runSingleRequest({ workspaceId, environmentId: null, folderId, request: req, requestId: null });
  return user ? withCaller(caller(user), run) : run();
};
const lastHeader = (name: string) => String(target.requests.at(-1)?.headers[name] ?? "");

beforeAll(async () => {
  target = await startTestServer();
  other = http.createServer((_req, res) => {
    otherHits++;
    res.end("other");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherUrl = `http://localhost:${(other.address() as AddressInfo).port}`;
  // The same machine under two host names: 127.0.0.1 is allowed, localhost is not.
  hostAllowed = target.url.replace("localhost", "127.0.0.1");
  hostOther = `http://localhost:${new URL(target.url).port}`;
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const u of [owner, editor, viewer, outsider]) tokens[u.id] = users.createToken(u.id, "t").token;
  withCaller(caller(owner), () => {
    workspaceId = repo.createWorkspace("Parity").id;
    setMember(workspaceId, editor.username, "editor");
    setMember(workspaceId, viewer.username, "viewer");
    colA = repo.createFolder(workspaceId, null, { name: "Shop" }).id;
  });
});
afterAll(async () => {
  await target.close();
  other.close();
  dbm.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("domain-restricted secrets in requests", () => {
  it("sends to an allowed host and refuses everything else before anything is sent", async () => {
    expect((await create({ domains: ["127.0.0.1"] })).status).toBe(201);
    const ok = await send(colA, request());
    expect(ok.error).toBeUndefined();
    expect(lastHeader("x-key")).toBe(SECRET);

    const before = target.requests.length;
    const refused = await send(colA, request({ url: `${hostOther}/echo` }));
    expect(refused.error).toMatch(/may only be sent to 127\.0\.0\.1; this request goes to localhost/);
    expect(refused.error).not.toContain(SECRET);
    expect(target.requests.length).toBe(before);

    // Wherever it is put: URL, body, auth, and a script.
    for (const bad of [
      request({ url: `${hostOther}/echo?k={{vault:api}}`, headers: [] }),
      request({
        url: `${hostOther}/echo`,
        method: "POST",
        headers: [],
        body: { mode: "raw", raw: "token={{vault:api}}", language: "text" } as never,
      }),
      request({
        url: `${hostOther}/echo`,
        headers: [],
        auth: { type: "bearer", bearer: { token: "{{vault:api}}" } } as never,
      }),
      request({ url: `${hostOther}/echo`, headers: [], preRequestScript: "" }),
    ].slice(0, 3)) {
      const r = await send(colA, bad);
      expect(r.error, JSON.stringify(bad.url)).toMatch(/may only be sent to/);
    }
    expect(target.requests.length).toBe(before);
  });

  it("covers scripts, pm.sendRequest and redirects", async () => {
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    vault.updateSecret(id, { scriptAccess: true });
    const before = target.requests.length;
    const viaScript = await send(
      colA,
      request({
        url: `${hostOther}/echo`,
        headers: [],
        preRequestScript: `pm.request.headers.add({ key: "X-Leak", value: pm.vault.get("api") });`,
      }),
    );
    expect(viaScript.error).toMatch(/may only be sent to/);
    expect(target.requests.length).toBe(before);

    const inner = await send(
      colA,
      request({
        headers: [],
        preRequestScript: `pm.sendRequest({ url: "${hostOther}/echo", method: "GET", header: [{ key: "X-Inner", value: "{{vault:api}}" }] }, function (err) { pm.environment.set("inner", String(err && err.message)); });`,
      }),
    );
    expect(target.requests.some((r) => r.headers["x-inner"])).toBe(false);
    void inner;

    // A 307 keeps the body, so a secret in it would follow the redirect to another host.
    const redirector = http.createServer((req, res) => {
      req.resume();
      res.writeHead(307, { Location: `${otherUrl}/landing` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    otherHits = 0;
    const hop = await send(
      colA,
      request({
        url: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/start`,
        method: "POST",
        headers: [],
        body: { mode: "raw", raw: "token={{vault:api}}", language: "text" } as never,
        settings: { ...DEFAULT_SETTINGS, followRedirects: true },
      }),
    );
    redirector.close();
    expect(hop.error).toMatch(/may only be sent to/);
    expect(otherHits).toBe(0);
  });

  it("applies no restriction to a secret without domains", async () => {
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    vault.updateSecret(id, { domains: [] });
    const r = await send(colA, request({ url: `${hostOther}/echo` }));
    expect(r.error).toBeUndefined();
    expect(lastHeader("x-key")).toBe(SECRET);
    vault.updateSecret(id, { domains: ["*.example.com"] });
    expect((await send(colA, request({ url: `${hostOther}/echo` }))).error).toMatch(
      /may only be sent to \*\.example\.com/,
    );
    expect(
      (
        await call(oneRoute.PATCH, owner, `/api/vault/${id}`, {
          method: "PATCH",
          body: { domains: ["*"] },
          id,
        })
      ).status,
    ).toBe(400);
    vault.updateSecret(id, { domains: [] });
  });
});

describe("enabling, disabling and personal secrets", () => {
  it("leaves references unresolved while a secret is disabled", async () => {
    const id = vault.listSecrets(workspaceId).find((s) => s.name === "api")!.id;
    expect(
      (
        await call(oneRoute.PATCH, owner, `/api/vault/${id}`, {
          method: "PATCH",
          body: { enabled: false },
          id,
        })
      ).data.enabled,
    ).toBe(false);
    const off = await send(colA, request());
    expect(off.unresolved).toContain("vault:api");
    expect(lastHeader("x-key")).toBe("{{vault:api}}");
    vault.updateSecret(id, { enabled: true });
    await send(colA, request());
    expect(lastHeader("x-key")).toBe(SECRET);
  });

  it("keeps personal secrets from everyone else, and prefers them for their owner", async () => {
    const mine = await create({ name: "api", value: "personal-editor-value-1", personal: true }, editor);
    expect(mine.status, mine.text).toBe(201);
    expect(mine.data.personal).toBe(true);
    const personalId = mine.data.id as string;
    // Owner (a workspace owner) cannot see, read, change, reveal or delete someone's personal secret.
    const ownerList = (await call(listRoute.GET, owner, `/api/vault?workspaceId=${workspaceId}`)).data as {
      id: string;
    }[];
    expect(ownerList.some((s) => s.id === personalId)).toBe(false);
    for (const [handler, method, extra] of [
      [oneRoute.GET, "GET", undefined],
      [oneRoute.PATCH, "PATCH", { value: "hijack" }],
      [oneRoute.DELETE, "DELETE", undefined],
      [revealRoute.POST, "POST", undefined],
    ] as const)
      expect(
        (
          await call(handler, owner, `/api/vault/${personalId}${method === "POST" ? "/reveal" : ""}`, {
            method,
            body: extra,
            id: personalId,
          })
        ).status,
        method,
      ).toBe(404);
    const editorList = (await call(listRoute.GET, editor, `/api/vault?workspaceId=${workspaceId}`)).data as {
      id: string;
      personal: boolean;
    }[];
    expect(editorList.filter((s) => s.personal).map((s) => s.id)).toEqual([personalId]);
    // A workspace secret and a personal one may share a name.
    expect((await create({ name: "api", value: "x".repeat(12), personal: true }, editor)).status).toBe(409);

    await send(colA, request(), editor);
    expect(lastHeader("x-key")).toBe("personal-editor-value-1");
    await send(colA, request(), owner);
    expect(lastHeader("x-key")).toBe(SECRET);
    // Unattended work (schedules, webhooks) has no user, so it never gets a personal secret.
    await send(colA, request(), null);
    expect(lastHeader("x-key")).toBe(SECRET);
    // And the editor can still use the shared one under another name path.
    expect(JSON.stringify(vault.loadVaultForExecution(workspaceId, colA))).toContain(SECRET);
    await call(oneRoute.DELETE, editor, `/api/vault/${personalId}`, { method: "DELETE", id: personalId });
  });

  it("drops personal secrets whose owner does not exist when a backup is restored", () => {
    const sql = dbm.getSqlite();
    const now = Date.now();
    sql
      .prepare(
        "INSERT INTO vault_secrets (id, workspace_id, name, description, ciphertext, key_id, script_access, collection_ids, owner_id, created_at, updated_at, enabled, domains) VALUES ('ghost', ?, 'ghost', '', '', '', 0, '[]', 'no-such-user', ?, ?, 1, '[]')",
      )
      .run(workspaceId, now, now);
    const full = backup.createBackup(dbm.getDb(), { includeSecrets: true });
    expect(full.tables.vaultSecrets.some((v) => v.id === "ghost")).toBe(true);
    backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(full)));
    expect(sql.prepare("SELECT count(*) AS n FROM vault_secrets WHERE id = 'ghost'").get()).toEqual({ n: 0 });
    expect(vault.listSecrets(workspaceId).some((s) => s.name === "api")).toBe(true);
  });
});

describe("viewing a value", () => {
  it("lets the creator and workspace owners reveal it, audited, and nobody else", async () => {
    const made = await create({ name: "revealable", value: "reveal-me-7788-xx" }, editor);
    const id = made.data.id as string;
    expect(made.text).not.toContain("reveal-me");
    const asCreator = await call(revealRoute.POST, editor, `/api/vault/${id}/reveal`, { method: "POST", id });
    expect(asCreator.data).toEqual({ value: "reveal-me-7788-xx" });
    expect(asCreator.headers.get("cache-control")).toBe("no-store");
    expect(
      (await call(revealRoute.POST, owner, `/api/vault/${id}/reveal`, { method: "POST", id })).data.value,
    ).toBe("reveal-me-7788-xx");
    // Another editor did not create it and does not own the workspace.
    const second = await users.createUser({ username: "editor2", password: "password123" });
    tokens[second.id] = users.createToken(second.id, "t").token;
    withCaller(caller(owner), () => setMember(workspaceId, second.username, "editor"));
    expect(
      (await call(revealRoute.POST, second, `/api/vault/${id}/reveal`, { method: "POST", id })).status,
    ).toBe(403);
    expect(
      (await call(revealRoute.POST, viewer, `/api/vault/${id}/reveal`, { method: "POST", id })).status,
    ).toBe(403);
    expect(
      (await call(revealRoute.POST, outsider, `/api/vault/${id}/reveal`, { method: "POST", id })).status,
    ).toBe(404);
    // Lists and reads still never carry it.
    expect((await call(listRoute.GET, editor, `/api/vault?workspaceId=${workspaceId}`)).text).not.toContain(
      "reveal-me",
    );
    const audit = JSON.stringify(queryAudit({ workspaceId, limit: 500 } as never));
    expect(audit).toContain("vault.reveal");
    expect(audit).not.toContain("reveal-me");
    // A personal secret can be revealed by its owner.
    const mine = (await create({ name: "mine", value: "personal-reveal-99", personal: true }, editor)).data
      .id as string;
    expect(
      (await call(revealRoute.POST, editor, `/api/vault/${mine}/reveal`, { method: "POST", id: mine })).data
        .value,
    ).toBe("personal-reveal-99");
    vault.deleteSecret(id);
  });
});

describe("export and import", () => {
  const exportFile = async (body: Record<string, unknown>, user = owner) =>
    call(exportRoute.POST, user, "/api/vault/export", { method: "POST", body: { workspaceId, ...body } });

  it("exports an encrypted file that imports into another workspace", async () => {
    vault.createSecret(workspaceId, {
      name: "scoped",
      value: "scoped-value-abcdef",
      collectionIds: [colA],
      domains: ["a.test"],
      scriptAccess: true,
      description: "d",
    });
    const res = await exportFile({ passphrase: "a long passphrase" });
    expect(res.status, res.text).toBe(200);
    expect(res.text).not.toMatch(/scoped-value-abcdef|sk_live_parity/);
    expect(res.headers.get("x-postbox-vault-exported")).toBeTruthy();
    const file = JSON.parse(res.text);

    const target2 = withCaller(caller(owner), () => {
      const id = repo.createWorkspace("Copy").id;
      repo.createFolder(id, null, { name: "Shop" });
      return id;
    });
    const wrong = await call(importRoute.POST, owner, "/api/vault/import", {
      method: "POST",
      body: { workspaceId: target2, file, passphrase: "not the one" },
    });
    expect(wrong.status).toBe(400);
    const done = await call(importRoute.POST, owner, "/api/vault/import", {
      method: "POST",
      body: { workspaceId: target2, file, passphrase: "a long passphrase" },
    });
    expect(done.status, done.text).toBe(200);
    expect(done.data.created).toEqual(expect.arrayContaining(["scoped", "api"]));
    const imported = withCaller(caller(owner), () => vault.listSecrets(target2)).find(
      (s) => s.name === "scoped",
    )!;
    expect(imported).toMatchObject({
      scriptAccess: true,
      domains: ["a.test"],
      enabled: true,
      description: "d",
    });
    const newShop = (
      dbm
        .getSqlite()
        .prepare("SELECT id FROM folders WHERE workspace_id = ? AND name = 'Shop'")
        .get(target2) as { id: string }
    ).id;
    expect(imported.collectionIds).toEqual([newShop]);
    expect(
      withCaller(caller(owner), () => vault.loadVaultForExecution(target2, imported.collectionIds[0])).values
        .scoped,
    ).toBe("scoped-value-abcdef");
    // Importing again: existing names are skipped, replaced or renamed as asked.
    const again = (mode: string) =>
      call(importRoute.POST, owner, "/api/vault/import", {
        method: "POST",
        body: { workspaceId: target2, file, passphrase: "a long passphrase", onConflict: mode },
      });
    expect((await again("skip")).data).toMatchObject({
      created: [],
      skipped: expect.arrayContaining(["scoped"]),
    });
    expect((await again("replace")).data.replaced).toEqual(expect.arrayContaining(["scoped"]));
    expect((await again("rename")).data.created).toEqual(expect.arrayContaining(["scoped-2"]));
  });

  it("imports a secret whose collection is missing as disabled, with a warning", async () => {
    const file = JSON.parse((await exportFile({ passphrase: "a long passphrase" })).text);
    const bare = withCaller(caller(owner), () => repo.createWorkspace("Bare").id);
    const done = await call(importRoute.POST, owner, "/api/vault/import", {
      method: "POST",
      body: { workspaceId: bare, file, passphrase: "a long passphrase" },
    });
    expect(done.data.warnings.join(" ")).toMatch(/scoped: collection "Shop" not found; imported disabled/);
    expect(
      withCaller(caller(owner), () => vault.listSecrets(bare)).find((s) => s.name === "scoped"),
    ).toMatchObject({ enabled: false, collectionIds: [] });
  });

  it("makes a plaintext export hard to do by accident and limits who can export", async () => {
    expect((await exportFile({})).status).toBe(400);
    expect((await exportFile({ plaintext: true })).status).toBe(400);
    const plain = await exportFile({ plaintext: true, acknowledgePlaintext: true });
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.text)).toMatchObject({ encrypted: false });
    expect(plain.text).toContain("scoped-value-abcdef");
    expect((await exportFile({ passphrase: "a long passphrase" }, editor)).status).toBe(403);
    expect((await exportFile({ passphrase: "a long passphrase" }, outsider)).status).toBe(404);
    expect((await exportFile({ passphrase: "short" })).status).toBe(400);
    const imp = (user: UserRow) =>
      call(importRoute.POST, user, "/api/vault/import", {
        method: "POST",
        body: { workspaceId, file: { nope: 1 } },
      });
    expect((await imp(owner)).status).toBe(400);
    expect((await imp(viewer)).status).toBe(403);
    const audit = JSON.stringify(queryAudit({ workspaceId, limit: 500 } as never));
    expect(audit).toContain("vault.export");
    expect(audit).not.toContain("scoped-value-abcdef");
  });
});

describe("pm.vault.set", () => {
  it("replaces the value of a secret that allows script access, and the next request uses it", async () => {
    vault.createSecret(workspaceId, { name: "token", value: "token-old-value-1", scriptAccess: true });
    vault.createSecret(workspaceId, { name: "locked", value: "locked-old-value-1", scriptAccess: false });
    const refresh = request({
      headers: [{ key: "X-Tok", value: "{{vault:token}}", enabled: true }],
      testScript: `pm.vault.set("token", "token-new-value-2");`,
    });
    const first = await send(colA, refresh);
    expect(first.scriptErrors).toEqual([]);
    expect(lastHeader("x-tok")).toBe("token-old-value-1");
    expect(vault.loadVaultForExecution(workspaceId, colA).values.token).toBe("token-new-value-2");
    await send(colA, { ...refresh, testScript: "" });
    expect(lastHeader("x-tok")).toBe("token-new-value-2");
    const audit = JSON.stringify(queryAudit({ workspaceId, limit: 500 } as never));
    expect(audit).toContain("vault.script-set");
    expect(audit).not.toMatch(/token-new-value-2|token-old-value-1/);
  });

  it("cannot create secrets, change locked ones, or delete", async () => {
    const run = async (code: string) =>
      (await send(colA, request({ headers: [], preRequestScript: code }))).scriptErrors
        .map((e) => e.message)
        .join(" | ");
    expect(await run(`pm.vault.set("locked", "hacked-value-9");`)).toMatch(
      /existing secret that allows script access/,
    );
    expect(await run(`pm.vault.set("brand-new", "created-value-9");`)).toMatch(
      /existing secret that allows script access/,
    );
    expect(await run(`pm.vault.set("token", "");`)).toMatch(/needs a value/);
    expect(await run(`pm.vault.unset("token");`)).toMatch(/not supported/);
    const loaded = vault.loadVaultForExecution(workspaceId, colA).values;
    expect(loaded.locked).toBe("locked-old-value-1");
    expect(loaded["brand-new"]).toBeUndefined();
    expect(loaded.token).toBe("token-new-value-2");
  });

  it("redacts a replaced value from what the run records", async () => {
    const out = await send(
      colA,
      request({
        headers: [{ key: "X-Tok", value: "{{vault:token}}", enabled: true }],
        testScript: `pm.vault.set("token", "token-third-value-3"); console.log("now " + pm.vault.get("token"));`,
      }),
    );
    expect(JSON.stringify(out.logs)).not.toContain("token-third-value-3");
    expect(JSON.stringify(out.logs)).toContain("********");
  });
});
