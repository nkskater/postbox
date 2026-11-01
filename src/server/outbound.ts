/**
 * Outbound network settings (administrators): the proxy and the TLS profiles. They live in the
 * database, are read on every request so changes apply immediately, and ride on the host policy
 * (`getPolicy().network`) into every outbound client. Passwords, private keys and passphrases are
 * write-only: they are never returned, listed, logged or audited by value.
 */
import { eq } from "drizzle-orm";
import {
  OutboundConfigError,
  OutboundNetwork,
  parseCertificates,
  parseProxyUrl,
  validateIdentity,
  type TlsProfile,
} from "@/core/http/outbound";
import { HostPatternSet, HostPolicyError, type HostPolicy } from "@/core/http/policy";
import { audit } from "./audit";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";

const { outboundProxy, tlsProfiles } = schema;
const PROXY_ID = "default";
const MAX_BYPASS = 200;
const MAX_HOSTS = 50;
const MAX_PEM = 128 * 1024;
const MAX_PROFILES = 100;

const bad = (message: string) => new HttpError(400, message);

function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OutboundConfigError || err instanceof HostPolicyError) throw bad(err.message);
    throw err;
  }
}

/** The network configuration as stored, for building the active policy. */
export function loadOutboundNetwork(): OutboundNetwork | null {
  const db = getDb();
  const proxy = db.select().from(outboundProxy).where(eq(outboundProxy.id, PROXY_ID)).get();
  const profiles = db.select().from(tlsProfiles).all();
  const active = proxy?.enabled ? proxy : null;
  if (!active && profiles.length === 0) return null;
  return new OutboundNetwork({
    proxy: active
      ? {
          url: active.url,
          username: active.username || undefined,
          password: active.password || undefined,
          bypass: active.bypass,
        }
      : null,
    profiles: profiles.map(toProfile),
  });
}

/** The environment policy together with the saved proxy and TLS profiles. */
export function withOutbound(base: HostPolicy): HostPolicy {
  return base.withNetwork(loadOutboundNetwork());
}

function toProfile(row: typeof tlsProfiles.$inferSelect): TlsProfile {
  return {
    id: row.id,
    name: row.name,
    hosts: row.hosts,
    ca: row.caPem || undefined,
    cert: row.certPem || undefined,
    key: row.keyPem || undefined,
    passphrase: row.passphrase || undefined,
  };
}

// ---- proxy ---------------------------------------------------------------------------------

export interface ProxyView {
  configured: boolean;
  enabled: boolean;
  url: string;
  username: string;
  passwordSet: boolean;
  bypass: string[];
  updatedAt: number | null;
}

export function getProxy(): ProxyView {
  const row = getDb().select().from(outboundProxy).where(eq(outboundProxy.id, PROXY_ID)).get();
  if (!row)
    return {
      configured: false,
      enabled: false,
      url: "",
      username: "",
      passwordSet: false,
      bypass: [],
      updatedAt: null,
    };
  return {
    configured: true,
    enabled: row.enabled,
    url: row.url,
    username: row.username,
    passwordSet: row.password !== "",
    bypass: row.bypass,
    updatedAt: row.updatedAt,
  };
}

export interface ProxyInput {
  url: string;
  enabled?: boolean;
  username?: string;
  /** Omit to keep the stored password; an empty string clears it. */
  password?: string;
  bypass?: string[];
}

function validateBypass(list: string[]): string[] {
  const cleaned = list.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length > MAX_BYPASS) throw bad(`The bypass list is limited to ${MAX_BYPASS} entries`);
  if (cleaned.some((p) => p.length > 253)) throw bad("A bypass entry is too long");
  checked(() => new HostPatternSet(cleaned, "bypass list"));
  return [...new Set(cleaned)];
}

export function setProxy(input: ProxyInput): ProxyView {
  const db = getDb();
  const existing = db.select().from(outboundProxy).where(eq(outboundProxy.id, PROXY_ID)).get();
  const url = checked(() => parseProxyUrl(input.url));
  const username = input.username ?? existing?.username ?? "";
  const password = input.password ?? existing?.password ?? "";
  if (username.includes(":")) throw bad("A proxy username cannot contain a colon");
  if (username.length > 256 || password.length > 1024) throw bad("The proxy credentials are too long");
  if (password && !username) throw bad("A proxy password needs a username");
  const bypass = validateBypass(input.bypass ?? existing?.bypass ?? []);
  const row = {
    id: PROXY_ID,
    enabled: input.enabled ?? existing?.enabled ?? true,
    url: `${url.protocol}//${url.host}`,
    username,
    password,
    bypass,
    updatedAt: Date.now(),
  };
  if (existing) db.update(outboundProxy).set(row).where(eq(outboundProxy.id, PROXY_ID)).run();
  else db.insert(outboundProxy).values(row).run();
  audit({
    action: "outbound.proxy.set",
    entityKind: "setting",
    entityId: PROXY_ID,
    entityName: "Outbound proxy",
    changes: [
      { field: "url", before: existing?.url ?? null, after: row.url },
      { field: "enabled", before: existing?.enabled ?? null, after: row.enabled },
      { field: "bypass", before: existing?.bypass ?? null, after: bypass },
      ...(username !== (existing?.username ?? "") ? [{ field: "username", redacted: true }] : []),
      ...(password !== (existing?.password ?? "") ? [{ field: "password", redacted: true }] : []),
    ].filter((c) => "redacted" in c || JSON.stringify(c.before) !== JSON.stringify(c.after)),
  });
  return getProxy();
}

export function clearProxy(): boolean {
  const res = getDb().delete(outboundProxy).where(eq(outboundProxy.id, PROXY_ID)).run();
  if (res.changes > 0)
    audit({
      action: "outbound.proxy.delete",
      entityKind: "setting",
      entityId: PROXY_ID,
      entityName: "Outbound proxy",
    });
  return res.changes > 0;
}

// ---- TLS profiles ---------------------------------------------------------------------------

export interface ProfileView {
  id: string;
  name: string;
  hosts: string[];
  ca: { subjects: string[]; expires: string | null } | null;
  clientCertificate: { subject: string; issuer: string; expires: string; fingerprint: string } | null;
  passphraseSet: boolean;
  updatedAt: number;
}

function view(row: typeof tlsProfiles.$inferSelect): ProfileView {
  let ca: ProfileView["ca"] = null;
  let clientCertificate: ProfileView["clientCertificate"] = null;
  try {
    if (row.caPem) {
      const certs = parseCertificates(row.caPem, "CA");
      ca = {
        subjects: certs.map((c) => c.subject.replace(/\n/g, ", ")),
        expires: new Date(Math.min(...certs.map((c) => new Date(c.validTo).getTime()))).toISOString(),
      };
    }
    if (row.certPem) {
      const [leaf] = parseCertificates(row.certPem, "Client certificate");
      clientCertificate = {
        subject: leaf.subject.replace(/\n/g, ", "),
        issuer: leaf.issuer.replace(/\n/g, ", "),
        expires: new Date(leaf.validTo).toISOString(),
        fingerprint: leaf.fingerprint256,
      };
    }
  } catch {
    /* stored material was validated on the way in */
  }
  return {
    id: row.id,
    name: row.name,
    hosts: row.hosts,
    ca,
    clientCertificate,
    passphraseSet: row.passphrase !== "",
    updatedAt: row.updatedAt,
  };
}

export function listProfiles(): ProfileView[] {
  return getDb()
    .select()
    .from(tlsProfiles)
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(view);
}

export function getProfile(id: string): ProfileView {
  const row = getDb().select().from(tlsProfiles).where(eq(tlsProfiles.id, id)).get();
  if (!row) throw notFound("TLS profile");
  return view(row);
}

export interface ProfileInput {
  name?: string;
  hosts?: string[];
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
}

function validateHosts(list: string[]): string[] {
  const hosts = [...new Set(list.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  if (hosts.length === 0) throw bad("Add at least one host pattern");
  if (hosts.length > MAX_HOSTS) throw bad(`A profile is limited to ${MAX_HOSTS} host patterns`);
  for (const raw of hosts) {
    const bracket = /^(\[[^\]]+\]):(\d{1,5})$/.exec(raw);
    const plain = !raw.startsWith("[") && raw.split(":").length === 2 ? /^(.+):(\d{1,5})$/.exec(raw) : null;
    const [host, port] = bracket ? [bracket[1], bracket[2]] : plain ? [plain[1], plain[2]] : [raw, undefined];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
      throw bad(`Invalid port in "${raw}"`);
    if (host === "*" || host.includes("/"))
      throw bad(`Host pattern "${raw}" must be a host name, *.domain, an address or host:port`);
    checked(() => new HostPatternSet([host], "TLS profile host"));
  }
  return hosts;
}

function pem(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_PEM) throw bad(`${label} is too large`);
  return value.trim() ? value.trim() + "\n" : "";
}

function buildRow(input: ProfileInput, existing?: typeof tlsProfiles.$inferSelect) {
  const name = (input.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw bad("Give the profile a name of up to 80 characters");
  const hosts = validateHosts(input.hosts ?? existing?.hosts ?? []);
  const caPem = pem(input.ca, "The CA certificate") ?? existing?.caPem ?? "";
  const certPem = pem(input.cert, "The client certificate") ?? existing?.certPem ?? "";
  const keyPem = pem(input.key, "The private key") ?? existing?.keyPem ?? "";
  const passphrase = input.passphrase ?? existing?.passphrase ?? "";
  if (!caPem && !certPem && !keyPem)
    throw bad("Provide a CA certificate, a client certificate and key, or both");
  if (passphrase && !keyPem) throw bad("A passphrase needs a private key");
  checked(() =>
    validateIdentity({
      ca: caPem || undefined,
      cert: certPem || undefined,
      key: keyPem || undefined,
      passphrase: passphrase || undefined,
    }),
  );
  return { name, hosts, caPem, certPem, keyPem, passphrase };
}

function describeProfileChange(
  before: typeof tlsProfiles.$inferSelect | undefined,
  after: ReturnType<typeof buildRow> | null,
) {
  const secret = (field: string, b?: string, a?: string) =>
    (b ?? "") !== (a ?? "") ? [{ field, redacted: true }] : [];
  return [
    ...(before?.name !== after?.name
      ? [{ field: "name", before: before?.name ?? null, after: after?.name ?? null }]
      : []),
    ...(JSON.stringify(before?.hosts) !== JSON.stringify(after?.hosts)
      ? [{ field: "hosts", before: before?.hosts ?? null, after: after?.hosts ?? null }]
      : []),
    ...secret("ca", before?.caPem, after?.caPem),
    ...secret("clientCertificate", before?.certPem, after?.certPem),
    ...secret("privateKey", before?.keyPem, after?.keyPem),
    ...secret("passphrase", before?.passphrase, after?.passphrase),
  ];
}

export function createProfile(input: ProfileInput): ProfileView {
  const db = getDb();
  if (db.select().from(tlsProfiles).all().length >= MAX_PROFILES)
    throw bad(`At most ${MAX_PROFILES} TLS profiles can be saved`);
  const fields = buildRow(input);
  if (db.select().from(tlsProfiles).where(eq(tlsProfiles.name, fields.name)).get())
    throw new HttpError(409, `A TLS profile named "${fields.name}" already exists`);
  const now = Date.now();
  const row = { id: newId(), ...fields, createdAt: now, updatedAt: now };
  db.insert(tlsProfiles).values(row).run();
  audit({
    action: "outbound.tls-profile.create",
    entityKind: "setting",
    entityId: row.id,
    entityName: row.name,
    changes: describeProfileChange(undefined, fields),
  });
  return view(row);
}

export function updateProfile(id: string, input: ProfileInput): ProfileView {
  const db = getDb();
  const existing = db.select().from(tlsProfiles).where(eq(tlsProfiles.id, id)).get();
  if (!existing) throw notFound("TLS profile");
  const fields = buildRow(input, existing);
  const clash = db.select().from(tlsProfiles).where(eq(tlsProfiles.name, fields.name)).get();
  if (clash && clash.id !== id)
    throw new HttpError(409, `A TLS profile named "${fields.name}" already exists`);
  db.update(tlsProfiles)
    .set({ ...fields, updatedAt: Date.now() })
    .where(eq(tlsProfiles.id, id))
    .run();
  audit({
    action: "outbound.tls-profile.update",
    entityKind: "setting",
    entityId: id,
    entityName: fields.name,
    changes: describeProfileChange(existing, fields),
  });
  return getProfile(id);
}

export function deleteProfile(id: string): void {
  const db = getDb();
  const existing = db.select().from(tlsProfiles).where(eq(tlsProfiles.id, id)).get();
  if (!existing) throw notFound("TLS profile");
  db.delete(tlsProfiles).where(eq(tlsProfiles.id, id)).run();
  audit({
    action: "outbound.tls-profile.delete",
    entityKind: "setting",
    entityId: id,
    entityName: existing.name,
    changes: describeProfileChange(existing, null),
  });
}

// ---- read-only policy view ---------------------------------------------------------------------

export interface PolicyView {
  allow: string[];
  deny: string[];
  sockets: string[];
  proxy: ProxyView;
  profiles: number;
  /** How the rules apply to a target reached through the proxy. */
  proxiedTargets: string[];
}

export function describePolicy(base: HostPolicy): PolicyView {
  const rules = base.describe();
  return {
    ...rules,
    proxy: getProxy(),
    profiles: listProfiles().length,
    proxiedTargets: [
      "Direct connections: the name and every resolved address are checked.",
      "Through the proxy: only the name can be checked, because the proxy resolves it.",
      "Deny rules by name and literal addresses are enforced as written.",
      "With an allow list, a host name must match it by name or wildcard.",
      "With deny rules by address or range, a host name is allowed only when listed by name in PROXY_ALLOW_HOSTS.",
      "The proxy address itself is trusted (an administrator sets it) and is not checked.",
      "gRPC and MQTT dial resolved addresses directly and refuse hosts that would use the proxy.",
    ],
  };
}
