import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import { fakeOidc } from "./helpers/sso-idp";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sso-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "keys.json");
delete process.env.POSTBOX_TOKEN;
const { getDb, getSqlite, schema } = await import("@/server/db"),
  users = await import("@/server/users"),
  sso = await import("@/server/sso"),
  { withCaller } = await import("@/server/access-context"),
  { providerInput } = await import("@/core/sso/model"),
  { callerOf } = await import("@/server/caller"),
  { rotateKeys } = await import("@/server/vault"),
  handlers = await import("@/server/sso-routes"),
  { route } = await import("@/server/http"),
  { proxy } = await import("@/proxy"),
  adminHandlers = await import("@/app/api/admin/sso/route");
let admin: UserRow, plain: UserRow, ws: string, idp: Awaited<ReturnType<typeof fakeOidc>>;
const own = <T>(fn: () => T) => withCaller({ kind: "user", user: admin, via: "session" } as Caller, fn);
function create(overrides = {}) {
  return own(() =>
    sso.saveProvider(undefined, {
      kind: "oidc",
      name: "Provider",
      origin: "http://localhost:7777",
      issuer: idp.issuer,
      clientId: "client",
      clientAuth: "none",
      enabled: true,
      autoProvision: true,
      ...overrides,
    }),
  ).id;
}
const identity = (subject = "verified-subject", groups: string[] = []) => ({
  subject,
  claims: { name: "Federated", groups, email: "local@example.com" },
  expiresAt: Date.now() + 300000,
});
beforeAll(async () => {
  idp = await fakeOidc();
  admin = await users.createUser({ username: "local-admin", password: "password123", isAdmin: true });
  plain = await users.createUser({ username: "local", password: "password123" });
  ws = getDb()
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.name, "local-admin's Workspace"))
    .get()!.id;
});
afterAll(async () => {
  await idp.close();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
it("requires recovery credentials before enabling SSO and validates trust configuration", () => {
  getDb().update(schema.users).set({ disabled: true }).where(eq(schema.users.id, admin.id)).run();
  expect(() => create()).toThrow(/local administrator/);
  users.setDisabled(admin.id, false);
  admin = users.getUser(admin.id)!;
  const id = create();
  expect(() =>
    own(() => sso.saveProvider(id, { ...sso.provider(id).config, issuer: "https://other.example" })),
  ).toThrow(/new provider/);
  expect(
    providerInput.safeParse({ ...sso.provider(id).config, origin: "http://remote.example" }).success,
  ).toBe(false);
});
it("encrypts credentials, never returns them, and preserves pending logins through key rotation/pruning", () => {
  const id = own(() =>
    sso.saveProvider(
      undefined,
      { ...sso.provider(create()).config, clientAuth: "basic" },
      { clientSecret: "private-client-secret" },
    ),
  ).id;
  const login = sso.createState(id, "/profile");
  expect(JSON.stringify(own(sso.listProviders))).not.toContain("private-client-secret");
  expect(sso.provider(id).secrets).not.toContain("private-client-secret");
  rotateKeys({ newKey: true, prune: true });
  expect(sso.providerSecrets(id).clientSecret).toBe("private-client-secret");
  expect(sso.consumeState(id, login.state, login.browser).payload).toEqual(login.payload);
});
it("binds one-use state to its browser and provider and rejects expiry and configuration revisions", () => {
  const id = create(),
    other = create(),
    login = sso.createState(id, "//attacker.example");
  expect(login.payload.next).toBe("/");
  expect(() => sso.consumeState(id, login.state, sso.random())).toThrow();
  expect(() => sso.consumeState(other, login.state, login.browser)).toThrow();
  expect(sso.consumeState(id, login.state, login.browser).payload.nonce).toBe(login.payload.nonce);
  expect(() => sso.consumeState(id, login.state, login.browser)).toThrow();
  const changed = sso.createState(id, "/");
  own(() => sso.saveProvider(id, sso.provider(id).config));
  expect(() => sso.consumeState(id, changed.state, changed.browser)).toThrow();
  const expired = sso.createState(id, "/");
  getDb()
    .update(schema.ssoStates)
    .set({ expiresAt: Date.now() - 1 })
    .where(eq(schema.ssoStates.id, sso.hash(expired.state)))
    .run();
  expect(() => sso.consumeState(id, expired.state, expired.browser)).toThrow();
});
it("provisions a non-admin account without email linking and honors disabling/deletion and revision races", () => {
  const id = create(),
    p = sso.provider(id),
    result = sso.finishLogin(id, p.revision, identity());
  expect(result.user.id).not.toBe(plain.id);
  expect(result.user.isAdmin).toBe(false);
  expect(result.user.passwordHash).toBe("!");
  expect(sso.finishLogin(id, p.revision, identity()).user.id).toBe(result.user.id);
  users.setDisabled(result.user.id, true);
  expect(() => sso.finishLogin(id, p.revision, identity())).toThrow(/unavailable/);
  own(() => sso.saveProvider(id, p.config));
  expect(() => sso.finishLogin(id, p.revision, identity("new-subject"))).toThrow(/no longer valid/);
});
it("requires explicit identity mappings when provisioning is disabled and never promotes a global admin", () => {
  const id = create({ autoProvision: false }),
    p = sso.provider(id);
  expect(() => sso.finishLogin(id, p.revision, identity())).toThrow(/must map/);
  own(() => sso.mapIdentity(id, "verified-subject", plain.id));
  expect(sso.finishLogin(id, p.revision, identity()).user.id).toBe(plain.id);
  expect(sso.finishLogin(id, p.revision, identity()).user.isAdmin).toBe(false);
  expect(() => own(() => sso.mapIdentity(id, "verified-subject", admin.id))).toThrow(/already mapped/);
});
it("reconciles only managed group roles and revokes them with linked browser sessions on provider disable", () => {
  const id = create({
      roles: [
        { workspaceId: ws, group: "developers", role: "viewer" },
        { workspaceId: ws, group: "leads", role: "editor" },
      ],
    }),
    p = sso.provider(id);
  const user = sso.finishLogin(id, p.revision, identity("roles", ["developers", "leads"])).user;
  const member = () =>
    getDb()
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, user.id), eq(schema.workspaceMembers.workspaceId, ws)))
      .get();
  expect(member()?.role).toBe("editor");
  sso.finishLogin(id, p.revision, identity("roles", ["developers"]));
  expect(member()?.role).toBe("viewer");
  sso.finishLogin(id, p.revision, identity("roles"));
  expect(member()).toBeUndefined();
  sso.finishLogin(id, p.revision, identity("roles", ["leads"]));
  const version = users.getUser(user.id)!.sessionVersion;
  own(() => sso.saveProvider(id, { ...p.config, enabled: false }));
  expect(member()).toBeUndefined();
  expect(users.getUser(user.id)!.sessionVersion).toBeGreaterThan(version);
});
it("preserves manual workspace memberships when applying or revoking SSO rules", () => {
  const id = create({ roles: [{ workspaceId: ws, group: "developers", role: "owner" }] }),
    p = sso.provider(id);
  own(() => sso.mapIdentity(id, "manual", plain.id));
  getDb()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: ws, userId: plain.id, role: "viewer", createdAt: Date.now() })
    .run();
  sso.finishLogin(id, p.revision, identity("manual", ["developers"]));
  own(() => sso.deleteProvider(id));
  expect(
    getDb()
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, plain.id), eq(schema.workspaceMembers.workspaceId, ws)))
      .get()?.role,
  ).toBe("viewer");
});
it("uses atomic scoped SAML request consumption and provider-wide assertion replay protection", async () => {
  const a = sso.samlCache("p", "state-a"),
    b = sso.samlCache("p", "state-b");
  await a.saveAsync("request", "value");
  expect(await b.getAsync("request")).toBeNull();
  expect(await Promise.all([a.consumeAsync!("request"), a.consumeAsync!("request")])).toEqual([
    "value",
    null,
  ]);
  const replay = JSON.stringify(["assertion", "issuer", "id"]);
  expect(await a.saveIfAbsentAsync!(replay, "value", Date.now() + 300000)).toBe(true);
  expect(await b.saveIfAbsentAsync!(replay, "value", Date.now() + 300000)).toBe(false);
});
it("rejects nonadmin provider management and permits only correlated SAML callback origin exceptions", async () => {
  const token = users.createToken(plain.id, "plain", null, { scope: "full" });
  const response = await adminHandlers.GET(
    new Request("http://localhost/api/admin/sso", { headers: { authorization: `Bearer ${token.token}` } }),
  );
  expect(response.status).toBe(403);
  const callback = proxy(
    new NextRequest("http://localhost/api/auth/sso/provider/callback", {
      method: "POST",
      headers: { Origin: "https://idp.example" },
    }),
  );
  expect(callback.status).toBe(200);
  const invalid = await route(handlers.callbackSso)(
    new NextRequest("http://localhost/api/auth/sso/provider/callback", {
      method: "POST",
      body: "RelayState=forged&SAMLResponse=forged",
    }),
    { params: Promise.resolve({ id: "provider" }) },
  );
  expect(invalid.status).toBe(400);
  expect(
    proxy(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { Origin: "https://idp.example" },
      }),
    ).status,
  ).toBe(403);
});
it("completes a real signed OIDC callback, clamps session expiry, rejects reuse, and honors logout", async () => {
  const id = create({ sessionSeconds: 60 });
  const context = { params: Promise.resolve({ id }) },
    start = await handlers.startSso(
      new NextRequest(`http://localhost:7777/api/auth/sso/${id}/start?next=/profile`),
      context,
    );
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const authorization = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const callback = authorization.headers.get("location")!;
  const request = new NextRequest(callback, { headers: { cookie } });
  const response = await route(handlers.callbackSso)(request, context);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("http://localhost:7777/profile");
  const session = response.headers.get("set-cookie")!.match(/postbox_session=([^;]+)/)![1];
  expect(
    callerOf(new Request("http://localhost", { headers: { cookie: `postbox_session=${session}` } }))?.kind,
  ).toBe("user");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const { parseUserSession } = await import("@/server/auth");
  const { sessionSecret } = await import("@/server/caller");
  expect(Number(session.split(".")[3]) - Date.now()).toBeLessThanOrEqual(60000);
  expect(parseUserSession(sessionSecret(), session, Date.now() + 61000)).toBeNull();
  expect(
    (await route(handlers.callbackSso)(new NextRequest(callback, { headers: { cookie } }), context)).status,
  ).toBe(400);
  const logout = await import("@/app/api/auth/logout/route");
  expect(logout.POST().headers.get("set-cookie")).toContain("Max-Age=0");
});

it("refuses insecure backchannel endpoints before sending credentials", async () => {
  const { ssoFetch } = await import("@/server/sso-transport");
  await expect(
    ssoFetch("http://remote.example/token", {
      method: "POST",
      headers: { Authorization: "Basic private" },
      body: "",
      redirect: "manual",
    }),
  ).rejects.toThrow(/HTTPS/);
});

it("returns bounded generic errors for malformed admin configuration bodies", async () => {
  const token = users.createToken(admin.id, "SSO admin", null, { scope: "full" });
  for (const body of ['{"secrets":{"clientSecret":"private-malformed', "null"]) {
    const response = await adminHandlers.POST(
      new Request("http://localhost/api/admin/sso", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}` },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-malformed");
  }
});

it("preserves other-provider grant ownership after a manual membership removal", () => {
  const roles = [{ workspaceId: ws, group: "developers", role: "editor" }];
  const a = create({ roles }),
    b = create({ roles });
  const user = sso.finishLogin(a, 1, identity("shared-subject", ["developers"])).user;
  own(() => sso.mapIdentity(b, "shared-subject", user.id));
  getDb()
    .delete(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.userId, user.id), eq(schema.workspaceMembers.workspaceId, ws)))
    .run();
  expect(sso.finishLogin(b, 1, identity("shared-subject", ["developers"])).user.id).toBe(user.id);
  expect(
    getDb()
      .select()
      .from(schema.ssoRoleGrants)
      .where(and(eq(schema.ssoRoleGrants.userId, user.id), eq(schema.ssoRoleGrants.workspaceId, ws)))
      .get()?.providerId,
  ).toBe(a);
});

it("lets recovery administrators inspect, disable and replace unreadable credentials", () => {
  const id = own(() =>
    sso.saveProvider(
      undefined,
      { ...sso.provider(create()).config, clientAuth: "basic" },
      { clientSecret: "old" },
    ),
  ).id;
  getDb()
    .update(schema.ssoProviders)
    .set({ secrets: "unreadable" })
    .where(eq(schema.ssoProviders.id, id))
    .run();
  expect(own(sso.listProviders).find((p) => p.id === id)?.credentialsReadable).toBe(false);
  const config = sso.provider(id).config;
  own(() => sso.saveProvider(id, { ...config, enabled: false }));
  expect(() => own(() => sso.saveProvider(id, config))).toThrow(/replacement/);
  own(() => sso.saveProvider(id, config, { clientSecret: "replacement" }));
  expect(sso.providerSecrets(id).clientSecret).toBe("replacement");
});
