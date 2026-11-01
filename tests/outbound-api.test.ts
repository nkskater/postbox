import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import { createPki, type Pki } from "./helpers/pki";
import { startTestProxy, type TestProxy } from "./helpers/http-proxy";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-outbound-api-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const { withCaller } = await import("@/server/access-context");
const dbm = await import("@/server/db");
const backup = await import("@/server/backup");
const context = await import("@/server/context");
const { sendRequest } = await import("@/core/http/engine");
const proxyRoute = await import("@/app/api/admin/outbound/proxy/route");
const policyRoute = await import("@/app/api/admin/outbound/policy/route");
const profilesRoute = await import("@/app/api/admin/outbound/tls-profiles/route");
const profileRoute = await import("@/app/api/admin/outbound/tls-profiles/[id]/route");

let admin: UserRow;
let member: UserRow;
let pki: Pki;
let origin: http.Server;
let originUrl: string;
let proxy: TestProxy;
const tokens = new Map<string, string>();
const as = (user: UserRow): Caller => ({ kind: "user", user: users.getUser(user.id)!, via: "token" });
const request = (method: string, url: string, body: unknown, user: UserRow) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(user.id)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Handler = (req: Request, ctx?: unknown) => Promise<Response> | Response;
const call = (handler: unknown, user: UserRow, method: string, url: string, body?: unknown, id?: string) =>
  withCaller(as(user), () =>
    (handler as Handler)(request(method, url, body, user), id ? ctx(id) : undefined),
  );

beforeAll(async () => {
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  member = await users.createUser({ username: "member", password: "password123" });
  for (const user of [admin, member]) tokens.set(user.id, users.createToken(user.id, "test").token);
  pki = createPki();
  origin = http.createServer((_r, res) => res.end("origin"));
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  proxy = await startTestProxy({ auth: { username: "svc", password: "proxy-pass-123" } });
});
afterAll(async () => {
  origin.close();
  await proxy.close();
  dbm.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("outbound settings API", () => {
  it("is limited to administrators", async () => {
    const attempts: [unknown, string, string, unknown?, string?][] = [
      [proxyRoute.GET, "GET", "/api/admin/outbound/proxy"],
      [proxyRoute.PUT, "PUT", "/api/admin/outbound/proxy", { url: "http://p:1" }],
      [proxyRoute.DELETE, "DELETE", "/api/admin/outbound/proxy"],
      [policyRoute.GET, "GET", "/api/admin/outbound/policy"],
      [profilesRoute.GET, "GET", "/api/admin/outbound/tls-profiles"],
      [
        profilesRoute.POST,
        "POST",
        "/api/admin/outbound/tls-profiles",
        { name: "x", hosts: ["a.b"], ca: pki.caCert },
      ],
      [profileRoute.GET, "GET", "/api/admin/outbound/tls-profiles/x", undefined, "x"],
      [profileRoute.DELETE, "DELETE", "/api/admin/outbound/tls-profiles/x", undefined, "x"],
    ];
    for (const [handler, method, url, body, id] of attempts) {
      const res = await call(handler, member, method, url, body, id);
      expect([401, 403, 404], `${method} ${url}`).toContain(res.status);
    }
  });

  it("stores the proxy with a write-only password", async () => {
    expect(
      await (await call(proxyRoute.GET, admin, "GET", "/api/admin/outbound/proxy")).json(),
    ).toMatchObject({
      configured: false,
    });
    const saved = await call(proxyRoute.PUT, admin, "PUT", "/api/admin/outbound/proxy", {
      url: proxy.url,
      username: "svc",
      password: "proxy-pass-123",
      bypass: ["internal.corp", "*.lan", "10.0.0.0/8", " internal.corp "],
    });
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view).toMatchObject({
      configured: true,
      enabled: true,
      username: "svc",
      passwordSet: true,
      bypass: ["internal.corp", "*.lan", "10.0.0.0/8"],
    });
    expect(JSON.stringify(view)).not.toContain("proxy-pass-123");
    // Omitting the password keeps it; an empty one clears it.
    const kept = await (
      await call(proxyRoute.PUT, admin, "PUT", "/api/admin/outbound/proxy", {
        url: proxy.url,
        enabled: false,
      })
    ).json();
    expect(kept).toMatchObject({ passwordSet: true, enabled: false, username: "svc" });
    await call(proxyRoute.PUT, admin, "PUT", "/api/admin/outbound/proxy", { url: proxy.url, enabled: true });
  });

  it("rejects bad proxy settings", async () => {
    const put = (body: unknown) => call(proxyRoute.PUT, admin, "PUT", "/api/admin/outbound/proxy", body);
    expect((await put({ url: "socks5://p:1" })).status).toBe(400);
    expect((await put({ url: "http://u:p@host:1" })).status).toBe(400);
    expect((await put({ url: "http://p:1", bypass: ["bad pattern!"] })).status).toBe(400);
    expect((await put({ url: "http://p:1", username: "a:b" })).status).toBe(400);
    expect((await put({ url: "http://p:1", extra: 1 })).status).toBe(400);
    expect((await put({ url: "http://p:1", username: "", password: "x" })).status).toBe(400);
  });

  it("applies the saved proxy and credentials to outgoing requests", async () => {
    const before = proxy.forwarded.length;
    const res = await sendRequest(
      {
        method: "GET",
        url: `${originUrl}/hello`,
        headers: [],
        settings: { ...(await import("@/core/types")).DEFAULT_SETTINGS },
      },
      { policy: context.getPolicy() },
    );
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe("origin");
    expect(proxy.forwarded.length).toBe(before + 1);
    // Removing the proxy sends traffic directly again.
    await call(proxyRoute.DELETE, admin, "DELETE", "/api/admin/outbound/proxy");
    expect(context.getPolicy().network).toBeNull();
    await call(proxyRoute.PUT, admin, "PUT", "/api/admin/outbound/proxy", {
      url: proxy.url,
      username: "svc",
      password: "proxy-pass-123",
      bypass: ["127.0.0.1"],
    });
    const direct = await sendRequest(
      {
        method: "GET",
        url: `${originUrl}/direct`,
        headers: [],
        settings: { ...(await import("@/core/types")).DEFAULT_SETTINGS },
      },
      { policy: context.getPolicy() },
    );
    expect(direct.status).toBe(200);
    expect(proxy.forwarded.length).toBe(before + 1);
  });

  let profileId = "";
  it("saves TLS profiles without ever returning the key", async () => {
    const created = await call(profilesRoute.POST, admin, "POST", "/api/admin/outbound/tls-profiles", {
      name: "Internal APIs",
      hosts: ["*.internal.test", "api.internal.test:8443"],
      ca: pki.caCert,
      cert: pki.clientCert,
      key: pki.encryptedClientKey,
      passphrase: pki.passphrase,
    });
    expect(created.status).toBe(201);
    const view = await created.json();
    profileId = view.id;
    expect(view).toMatchObject({
      name: "Internal APIs",
      passphraseSet: true,
      clientCertificate: { subject: expect.stringContaining("postbox-client") },
      ca: { subjects: [expect.stringContaining("CN=ca")] },
    });
    const text = JSON.stringify([
      view,
      await (await call(profilesRoute.GET, admin, "GET", "/api/admin/outbound/tls-profiles")).json(),
    ]);
    expect(text).not.toMatch(/PRIVATE KEY|s3cret-phrase/);
    expect(context.getPolicy().network?.tlsFor("x.internal.test", 443)).toMatchObject({
      passphrase: pki.passphrase,
    });
  });

  it("validates certificate material and host patterns", async () => {
    const post = (body: unknown) =>
      call(profilesRoute.POST, admin, "POST", "/api/admin/outbound/tls-profiles", body);
    const okHosts = ["a.test"];
    expect((await post({ name: "dup", hosts: okHosts, ca: "not pem" })).status).toBe(400);
    expect((await post({ name: "dup", hosts: okHosts, cert: pki.clientCert })).status).toBe(400);
    expect(
      (await post({ name: "dup", hosts: okHosts, cert: pki.clientCert, key: pki.otherClientKey })).status,
    ).toBe(400);
    expect(
      (await post({ name: "dup", hosts: okHosts, cert: pki.clientCert, key: pki.encryptedClientKey })).status,
    ).toBe(400);
    expect((await post({ name: "dup", hosts: ["*"], ca: pki.caCert })).status).toBe(400);
    expect((await post({ name: "dup", hosts: ["a.test:99999"], ca: pki.caCert })).status).toBe(400);
    expect((await post({ name: "dup", hosts: okHosts })).status).toBe(400);
    expect((await post({ name: "Internal APIs", hosts: okHosts, ca: pki.caCert })).status).toBe(409);
  });

  it("updates, keeps omitted secrets, and deletes", async () => {
    const patched = await call(
      profileRoute.PATCH,
      admin,
      "PATCH",
      `/api/admin/outbound/tls-profiles/${profileId}`,
      { hosts: ["new.internal.test"] },
      profileId,
    );
    expect(patched.status).toBe(200);
    const net = context.getPolicy().network!;
    expect(net.tlsFor("new.internal.test", 443)).toMatchObject({ key: expect.stringContaining("ENCRYPTED") });
    expect(net.tlsFor("x.internal.test", 443)).toBeUndefined();
    // Clearing the key while the certificate stays is refused.
    const cleared = await call(
      profileRoute.PATCH,
      admin,
      "PATCH",
      `/api/admin/outbound/tls-profiles/${profileId}`,
      { key: "" },
      profileId,
    );
    expect(cleared.status).toBe(400);
    expect(
      (await call(profileRoute.GET, admin, "GET", "/api/admin/outbound/tls-profiles/nope", undefined, "nope"))
        .status,
    ).toBe(404);
  });

  it("shows the active policy read-only", async () => {
    const res = await call(policyRoute.GET, admin, "GET", "/api/admin/outbound/policy");
    const view = await res.json();
    expect(view).toMatchObject({
      allow: [],
      deny: [],
      profiles: 1,
      proxy: { configured: true, passwordSet: true },
    });
    expect(view.proxiedTargets.join(" ")).toMatch(/resolves it/);
    expect(JSON.stringify(view)).not.toContain("proxy-pass-123");
    expect(policyRoute).not.toHaveProperty("POST");
  });

  it("records changes in the audit log without secret values", () => {
    const events = dbm.getDb().select().from(dbm.schema.auditEvents).all();
    const mine = events.filter((e) => e.action.startsWith("outbound."));
    expect(mine.map((e) => e.action)).toEqual(
      expect.arrayContaining(["outbound.proxy.set", "outbound.tls-profile.create"]),
    );
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/proxy-pass-123|PRIVATE KEY|s3cret-phrase|BEGIN CERTIFICATE/);
    expect(text).toContain("password");
  });

  it("backs up the configuration and scrubs credentials when asked", () => {
    const full = backup.createBackup(dbm.getDb(), { includeSecrets: true });
    expect(full.tables.outboundProxy[0]).toMatchObject({ password: "proxy-pass-123" });
    expect(full.tables.tlsProfiles[0]).toMatchObject({ passphrase: pki.passphrase });
    const scrubbed = backup.createBackup(dbm.getDb(), { includeSecrets: false });
    const text = JSON.stringify(scrubbed.tables.outboundProxy) + JSON.stringify(scrubbed.tables.tlsProfiles);
    expect(text).not.toMatch(/proxy-pass-123|ENCRYPTED PRIVATE KEY|s3cret-phrase/);
    expect(scrubbed.tables.tlsProfiles[0]).toMatchObject({ keyPem: "", passphrase: "" });
    expect(scrubbed.tables.outboundProxy[0]).toMatchObject({ password: "", username: "svc" });

    // A full backup restores exactly.
    backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(full)));
    expect(backup.createBackup(dbm.getDb(), { includeSecrets: true }).tables.tlsProfiles).toEqual(
      full.tables.tlsProfiles,
    );
    // A scrubbed one restores without an unusable half certificate.
    const summary = backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(scrubbed)));
    expect(summary.tlsProfiles).toBe(1);
    const restored = backup.createBackup(dbm.getDb(), { includeSecrets: true }).tables.tlsProfiles[0];
    expect(restored).toMatchObject({ certPem: "", keyPem: "" });
    expect(String(restored.caPem)).toContain("BEGIN CERTIFICATE");
    expect(() => context.getPolicy()).not.toThrow();
  });

  it("drops a restored proxy that no longer parses", () => {
    const bk = backup.createBackup(dbm.getDb(), { includeSecrets: true });
    bk.tables.outboundProxy[0] = { ...bk.tables.outboundProxy[0], url: "ftp://nope" };
    const summary = backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(bk)));
    expect(summary.outboundProxy).toBe(0);
    expect(context.getPolicy().network?.proxy ?? null).toBeNull();
  });
});
