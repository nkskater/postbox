import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { CacheProvider } from "@node-saml/node-saml";
import {
  providerInput,
  secretInput,
  type Provider,
  type ProviderSecrets,
  type VerifiedIdentity,
  safeNext,
} from "@/core/sso/model";
import { encryptSecret, decryptSecret } from "@/core/vault/crypto";
import { getDb, schema } from "./db";
import { getKeys } from "./vault-keys";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import { getUser, insertPreparedUser, listUsers } from "./users";
import { requireAdmin } from "./authorize";

const {
  ssoProviders: providers,
  ssoStates: states,
  ssoIdentities: identities,
  ssoReplayCache: cache,
  ssoRoleGrants: grants,
  workspaceMembers: members,
  users,
} = schema;
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const random = () => randomBytes(32).toString("base64url");
const seal = (id: string, value: unknown) =>
  encryptSecret(getKeys().ring, "instance", `sso-${id}`, JSON.stringify(value)).ciphertext;
const open = <T>(id: string, value: string): T =>
  JSON.parse(decryptSecret(getKeys().ring, "instance", `sso-${id}`, value));
export function provider(id: string) {
  const p = getDb().select().from(providers).where(eq(providers.id, id)).get();
  if (!p) throw new HttpError(404, "SSO provider not found");
  return p;
}
export function publicProviders() {
  return getDb()
    .select()
    .from(providers)
    .all()
    .filter((p) => p.config.enabled)
    .map((p) => ({ id: p.id, name: p.config.name, kind: p.config.kind }));
}
export function listProviders() {
  requireAdmin();
  return getDb()
    .select()
    .from(providers)
    .all()
    .map(({ secrets, ...p }) => {
      try {
        return {
          ...p,
          hasSecrets: Object.keys(open(p.id, secrets) as object).length > 0,
          credentialsReadable: true,
        };
      } catch {
        return { ...p, hasSecrets: true, credentialsReadable: false };
      }
    });
}
export function providerSecrets(id: string): ProviderSecrets {
  const p = provider(id);
  return open(id, p.secrets);
}
export function assertRecovery() {
  if (
    !process.env.POSTBOX_TOKEN &&
    !listUsers().some(
      (u) => u.isAdmin && !u.disabled && !u.deletedAt && !u.isService && u.passwordHash.startsWith("scrypt$"),
    )
  )
    throw new HttpError(
      409,
      "Create an active local administrator with a password or configure POSTBOX_TOKEN before enabling SSO",
    );
}
function revoke(id: string) {
  for (const identity of getDb().select().from(identities).where(eq(identities.providerId, id)).all())
    getDb()
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, identity.userId))
      .run();
  for (const g of getDb().select().from(grants).where(eq(grants.providerId, id)).all()) {
    getDb()
      .delete(members)
      .where(
        and(eq(members.workspaceId, g.workspaceId), eq(members.userId, g.userId), eq(members.role, g.role)),
      )
      .run();
  }
  getDb().delete(grants).where(eq(grants.providerId, id)).run();
}
export function saveProvider(id: string | undefined, config: unknown, secrets: unknown = {}) {
  requireAdmin();
  const parsed = providerInput.parse(config),
    supplied = secretInput.parse(secrets);
  if (parsed.enabled) assertRecovery();
  const old = id ? provider(id) : undefined;
  if (old && old.config.kind !== parsed.kind)
    throw new HttpError(400, "Create a new provider to change protocol");
  if (
    old &&
    ((old.config.kind === "oidc" &&
      parsed.kind === "oidc" &&
      (old.config.issuer !== parsed.issuer || old.config.clientId !== parsed.clientId)) ||
      (old.config.kind === "saml" &&
        parsed.kind === "saml" &&
        (old.config.idpIssuer !== parsed.idpIssuer || old.config.entityId !== parsed.entityId)))
  )
    throw new HttpError(400, "Create a new provider to change issuer or client/entity identity");
  id ??= newId();
  let previous: ProviderSecrets = {},
    preserveUnreadable = false;
  if (old) {
    try {
      previous = providerSecrets(id);
    } catch {
      const replacement =
        parsed.kind === "oidc"
          ? supplied.clientSecret !== undefined || parsed.clientAuth === "none"
          : supplied.privateKey !== undefined || !parsed.publicCert;
      if (!replacement) {
        if (parsed.enabled)
          throw new HttpError(409, "Stored SSO credentials are unreadable; supply a replacement credential");
        preserveUnreadable = true;
      }
    }
  }
  const merged = { ...previous, ...supplied };
  const ciphertext = preserveUnreadable ? old!.secrets : seal(id, merged);
  if (parsed.enabled && parsed.kind === "oidc" && parsed.clientAuth !== "none" && !merged.clientSecret)
    throw new HttpError(400, "A client secret is required for this authentication method");
  if (parsed.enabled && parsed.kind === "saml" && !!merged.privateKey !== !!parsed.publicCert)
    throw new HttpError(400, "Supply both the SP private key and public certificate to sign requests");
  for (const role of parsed.roles)
    if (!getDb().select().from(schema.workspaces).where(eq(schema.workspaces.id, role.workspaceId)).get())
      throw new HttpError(400, "Role mapping workspace does not exist");
  const now = Date.now(),
    providerId = id;
  getDb().transaction(() => {
    if (old) revoke(providerId);
    getDb()
      .insert(providers)
      .values({
        id: providerId,
        config: parsed,
        secrets: ciphertext,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providers.id,
        set: {
          config: parsed,
          secrets: ciphertext,
          revision: sql`${providers.revision} + 1`,
          updatedAt: now,
        },
      })
      .run();
  });
  return { id };
}
export function deleteProvider(id: string) {
  requireAdmin();
  provider(id);
  getDb().transaction(() => {
    revoke(id);
    getDb().delete(providers).where(eq(providers.id, id)).run();
  });
}
export function mapIdentity(providerId: string, subject: string, userId: string) {
  requireAdmin();
  provider(providerId);
  if (!subject || subject.length > 2048 || !getUser(userId))
    throw new HttpError(400, "Supply an existing account and stable provider subject");
  getDb().transaction(() => {
    const existing = getDb()
      .select()
      .from(identities)
      .where(and(eq(identities.providerId, providerId), eq(identities.subject, subject)))
      .get();
    if (existing)
      throw new HttpError(409, "Subject is already mapped; remove the provider to reset mappings");
    getDb().insert(identities).values({ providerId, subject, userId }).run();
  });
}
export interface LoginState {
  verifier: string;
  nonce: string;
  next: string;
  requestId: string;
}
export function createState(id: string, next: string) {
  const p = provider(id);
  if (!p.config.enabled) throw new HttpError(403, "SSO provider is disabled");
  const state = random(),
    browser = random();
  const payload: LoginState = {
    verifier: random(),
    nonce: random(),
    next: safeNext(next),
    requestId: `_${random()}`,
  };
  getDb().delete(states).where(lt(states.expiresAt, Date.now())).run();
  getDb().delete(cache).where(lt(cache.expiresAt, Date.now())).run();
  if (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(states)
      .get()!.n >= 2000
  )
    throw new HttpError(429, "Too many pending SSO logins");
  getDb()
    .insert(states)
    .values({
      id: hash(state),
      providerId: id,
      browserHash: hash(browser),
      payload: seal(hash(state), payload),
      revision: p.revision,
      expiresAt: Date.now() + 300000,
    })
    .run();
  return { state, browser, payload, provider: p };
}
export function consumeState(id: string, state: string, browser: string) {
  if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser))
    throw new HttpError(400, "Invalid SSO login correlation");
  return getDb().transaction(() => {
    const found = getDb()
      .delete(states)
      .where(
        and(eq(states.id, hash(state)), eq(states.providerId, id), eq(states.browserHash, hash(browser))),
      )
      .returning()
      .get();
    const p = provider(id);
    if (!found || found.expiresAt <= Date.now() || found.revision !== p.revision || !p.config.enabled)
      throw new HttpError(400, "SSO login expired, changed, or already used");
    return { payload: open<LoginState>(hash(state), found.payload), provider: p };
  });
}
export function samlCache(id: string, state: string): CacheProvider {
  const keyOf = (key: string) =>
    `${id}:${key.startsWith('["assertion",') ? "replay" : hash(state)}:${hash(key)}`;
  const consume = async (key: string) =>
    getDb().transaction(() => {
      const item = getDb()
        .delete(cache)
        .where(eq(cache.id, keyOf(key)))
        .returning()
        .get();
      return item && item.expiresAt > Date.now() ? item.value : null;
    });
  return {
    async saveAsync(key, value) {
      const now = Date.now();
      getDb()
        .insert(cache)
        .values({ id: keyOf(key), value, expiresAt: now + 300000 })
        .onConflictDoNothing()
        .run();
      return { value, createdAt: now };
    },
    async getAsync(key) {
      const item = getDb()
        .select()
        .from(cache)
        .where(eq(cache.id, keyOf(key)))
        .get();
      return item && item.expiresAt > Date.now() ? item.value : null;
    },
    async removeAsync(key) {
      return key ? consume(key) : null;
    },
    consumeAsync: consume,
    async saveIfAbsentAsync(key, value, expiresAtMs) {
      return getDb().transaction(() => {
        getDb()
          .delete(cache)
          .where(and(eq(cache.id, keyOf(key)), lt(cache.expiresAt, Date.now())))
          .run();
        return !!getDb()
          .insert(cache)
          .values({ id: keyOf(key), value, expiresAt: expiresAtMs })
          .onConflictDoNothing()
          .returning()
          .get();
      });
    },
  };
}
export function finishLogin(id: string, revision: number, identity: VerifiedIdentity) {
  return getDb().transaction(() => {
    const p = provider(id),
      config = p.config;
    if (
      !config.enabled ||
      p.revision !== revision ||
      !identity.subject ||
      identity.subject.length > 2048 ||
      identity.expiresAt <= Date.now()
    )
      throw new HttpError(403, "SSO identity or configuration is no longer valid");
    let mapped = getDb()
      .select()
      .from(identities)
      .where(and(eq(identities.providerId, id), eq(identities.subject, identity.subject)))
      .get();
    if (!mapped) {
      if (!config.autoProvision)
        throw new HttpError(403, "An administrator must map this identity before sign-in");
      assertRecovery();
      const userId = newId(),
        now = Date.now(),
        username = `sso_${hash(`${id}\0${identity.subject}`).slice(0, 40)}`;
      const name = identity.claims[config.displayNameClaim];
      insertPreparedUser({
        id: userId,
        username,
        displayName: typeof name === "string" ? name.slice(0, 200) : username,
        passwordHash: "!",
        isAdmin: false,
        disabled: false,
        isService: false,
        sessionVersion: 1,
        createdAt: now,
        updatedAt: now,
        scimProfile: null,
        deletedAt: null,
      });
      mapped = { providerId: id, subject: identity.subject, userId };
      getDb().insert(identities).values(mapped).run();
    }
    const user = getUser(mapped.userId);
    if (!user || user.disabled || user.deletedAt || user.isService)
      throw new HttpError(403, "Account is unavailable");
    reconcileRoles(id, user.id, config, identity.claims);
    return { user, expiresAt: Math.min(identity.expiresAt, Date.now() + config.sessionSeconds * 1000) };
  });
}
function reconcileRoles(id: string, userId: string, config: Provider, claims: Record<string, unknown>) {
  const old = getDb()
    .select()
    .from(grants)
    .where(and(eq(grants.providerId, id), eq(grants.userId, userId)))
    .all();
  for (const g of old)
    getDb()
      .delete(members)
      .where(
        and(eq(members.userId, userId), eq(members.workspaceId, g.workspaceId), eq(members.role, g.role)),
      )
      .run();
  getDb()
    .delete(grants)
    .where(and(eq(grants.providerId, id), eq(grants.userId, userId)))
    .run();
  const groups = claims[config.groupsClaim],
    values = Array.isArray(groups)
      ? groups.filter((v) => typeof v === "string")
      : typeof groups === "string"
        ? [groups]
        : [];
  const roles = new Map<string, "owner" | "editor" | "viewer">(),
    rank = { viewer: 1, editor: 2, owner: 3 };
  for (const rule of config.roles)
    if (
      values.includes(rule.group) &&
      rank[rule.role] > (roles.has(rule.workspaceId) ? rank[roles.get(rule.workspaceId)!] : 0)
    )
      roles.set(rule.workspaceId, rule.role);
  for (const [workspaceId, role] of roles) {
    // Existing manual or other-provider membership takes precedence and is never overwritten.
    if (
      getDb()
        .select()
        .from(members)
        .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)))
        .get()
    )
      continue;
    if (
      getDb()
        .select()
        .from(grants)
        .where(and(eq(grants.workspaceId, workspaceId), eq(grants.userId, userId)))
        .get()
    )
      continue;
    getDb().insert(members).values({ workspaceId, userId, role, createdAt: Date.now() }).run();
    getDb().insert(grants).values({ providerId: id, workspaceId, userId, role }).run();
  }
}
