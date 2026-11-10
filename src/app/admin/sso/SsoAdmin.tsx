"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Provider } from "@/core/sso/model";
type Row = { id: string; config: Provider; hasSecrets: boolean; credentialsReadable: boolean };
const initial = (): Provider => ({
  kind: "oidc",
  name: "",
  origin: "",
  enabled: false,
  autoProvision: false,
  sessionSeconds: 3600,
  displayNameClaim: "name",
  groupsClaim: "groups",
  roles: [],
  issuer: "",
  clientId: "",
  clientAuth: "basic",
  algorithm: "RS256",
});
async function call(url: string, method = "GET", body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? "Request failed");
  return value;
}
export function SsoAdmin() {
  const [rows, setRows] = useState<Row[]>([]),
    [config, setConfig] = useState<Provider>(initial),
    [id, setId] = useState<string>();
  const [secret, setSecret] = useState(""),
    [roles, setRoles] = useState("[]"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState(""),
    [userId, setUserId] = useState("");
  const refresh = () =>
    call("/api/admin/sso")
      .then((value) => {
        setRows(value);
        setConfig((old) => (old.origin ? old : { ...old, origin: window.location.origin }));
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  const edit = (row?: Row) => {
    setId(row?.id);
    setConfig(row?.config ?? { ...initial(), origin: window.location.origin });
    setRoles(JSON.stringify(row?.config.roles ?? [], null, 2));
    setSecret("");
    setNotice("");
    setError("");
  };
  const update = (key: string, value: unknown) => setConfig((old) => ({ ...old, [key]: value }) as Provider);
  const field = (key: string, title: string, multiline = false) => {
    const value = (config as unknown as Record<string, unknown>)[key];
    return (
      <Label className="grid gap-2" key={key}>
        {title}
        {multiline ? (
          <textarea
            className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
            value={String(value ?? "")}
            onChange={(e) => update(key, e.target.value || undefined)}
          />
        ) : (
          <Input value={String(value ?? "")} onChange={(e) => update(key, e.target.value)} />
        )}
      </Label>
    );
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await call(`/api/admin/sso${id ? `/${id}` : ""}`, id ? "PUT" : "POST", {
        config: { ...config, roles: JSON.parse(roles) },
        secrets: secret ? (config.kind === "oidc" ? { clientSecret: secret } : { privateKey: secret }) : {},
      });
      setId(result.id);
      setSecret("");
      await refresh();
      setNotice("Provider saved. Existing linked browser sessions have been revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <Link className="text-sm underline" href="/profile">
        Back to profile
      </Link>
      <h1 className="text-2xl font-semibold">Single sign-on</h1>
      <p className="text-sm text-muted-foreground">
        Connect an OpenID Connect or SAML 2.0 identity provider. Keep an active local administrator password
        or POSTBOX_TOKEN for recovery. Local password login remains available.
      </p>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3 text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded border p-3">
          {notice}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside className="space-y-2">
          <Button onClick={() => edit()}>New provider</Button>
          {rows.map((row) => (
            <button
              key={row.id}
              className="block w-full rounded border p-3 text-left"
              onClick={() => edit(row)}
            >
              {row.config.name}
              <span className="block text-xs text-muted-foreground">
                {row.config.kind.toUpperCase()} · {row.config.enabled ? "Enabled" : "Disabled"}
                {!row.credentialsReadable && " · Credential unavailable"}
              </span>
            </button>
          ))}
        </aside>
        <form onSubmit={save} className="space-y-4 rounded border p-5">
          <h2 className="font-semibold">{id ? "Edit provider" : "New provider"}</h2>
          <Label className="grid gap-2">
            Protocol
            <select
              className="rounded border bg-background p-2"
              disabled={!!id}
              value={config.kind}
              onChange={(e) => {
                const {
                  name,
                  origin,
                  enabled,
                  autoProvision,
                  sessionSeconds,
                  displayNameClaim,
                  groupsClaim,
                  roles,
                } = config;
                const base = {
                  name,
                  origin,
                  enabled,
                  autoProvision,
                  sessionSeconds,
                  displayNameClaim,
                  groupsClaim,
                  roles,
                };
                setConfig(
                  e.target.value === "oidc"
                    ? { ...initial(), ...base }
                    : { ...base, kind: "saml", entryPoint: "", idpIssuer: "", entityId: "", idpCert: "" },
                );
                setSecret("");
              }}
            >
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML 2.0</option>
            </select>
          </Label>
          {field("name", "Sign-in button name")}
          {field("origin", "Public Postbox origin")}
          {config.kind === "oidc" ? (
            <>
              {field("issuer", "Issuer URL")}
              {field("clientId", "Client ID")}
              <Label className="grid gap-2">
                Client authentication
                <select
                  className="rounded border bg-background p-2"
                  value={config.clientAuth}
                  onChange={(e) => update("clientAuth", e.target.value)}
                >
                  <option value="basic">Client secret basic</option>
                  <option value="post">Client secret post</option>
                  <option value="none">Public client (PKCE)</option>
                </select>
              </Label>
              <Label className="grid gap-2">
                ID token signing algorithm
                <select
                  className="rounded border bg-background p-2"
                  value={config.algorithm}
                  onChange={(e) => update("algorithm", e.target.value)}
                >
                  {["RS256", "PS256", "ES256", "EdDSA"].map((alg) => (
                    <option key={alg}>{alg}</option>
                  ))}
                </select>
              </Label>
            </>
          ) : (
            <>
              {field("entryPoint", "IdP sign-in URL")}
              {field("idpIssuer", "IdP issuer")}
              {field("entityId", "Postbox SP entity ID")}
              {field("idpCert", "Pinned IdP signing certificate (PEM)", true)}
              {field("publicCert", "Optional SP signing certificate (PEM)", true)}
            </>
          )}
          <Label className="grid gap-2">
            {config.kind === "oidc" ? "Client secret" : "Optional SP signing private key"}
            <textarea
              className="rounded border bg-background p-2 font-mono text-xs"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                id ? "Leave blank to keep the stored credential" : "Encrypted at rest; never returned"
              }
            />
          </Label>
          {field("displayNameClaim", "Display name claim")}
          {field("groupsClaim", "Groups claim")}
          <Label className="grid gap-2">
            Maximum session lifetime (seconds)
            <Input
              type="number"
              min={60}
              max={86400}
              value={config.sessionSeconds}
              onChange={(e) => update("sessionSeconds", Number(e.target.value))}
            />
          </Label>
          <Label className="grid gap-2">
            Workspace role mappings (JSON)
            <textarea
              className="min-h-24 rounded border bg-background p-2 font-mono text-xs"
              value={roles}
              onChange={(e) => setRoles(e.target.value)}
            />
          </Label>
          <p className="text-xs text-muted-foreground">
            Each mapping: {`{"workspaceId":"…","group":"developers","role":"editor"}`}. Roles: viewer, editor,
            owner. Matching signed groups grant the highest mapped role. Existing manual memberships take
            precedence.
          </p>
          <Label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.autoProvision}
              onChange={(e) => update("autoProvision", e.target.checked)}
            />
            Create an account for new verified subjects
          </Label>
          <Label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => update("enabled", e.target.checked)}
            />
            Enable sign-in
          </Label>
          <div className="flex gap-3">
            <Button disabled={busy} type="submit">
              Save provider
            </Button>
            {id && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy || config.enabled}
                onClick={async () => {
                  try {
                    await call(`/api/admin/sso/${id}`, "DELETE");
                    edit();
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Delete disabled provider
              </Button>
            )}
          </div>
          {id && (
            <div className="space-y-2 border-t pt-4 text-sm">
              <p>
                Callback URL:{" "}
                <code className="break-all">
                  {config.origin}/api/auth/sso/{id}/callback
                </code>
              </p>
              {config.kind === "saml" && (
                <a className="underline" href={`/api/auth/sso/${id}/metadata`}>
                  Service provider metadata
                </a>
              )}
              <h3 className="font-semibold">Map an existing account</h3>
              <p className="text-xs text-muted-foreground">
                Use the exact stable subject (OIDC sub or SAML NameID) and account ID. Email addresses never
                link accounts automatically.
              </p>
              <Label className="grid gap-2">
                Subject
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </Label>
              <Label className="grid gap-2">
                Account ID
                <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
              </Label>
              <Button
                type="button"
                variant="outline"
                disabled={!subject || !userId}
                onClick={async () => {
                  try {
                    await call(`/api/admin/sso/${id}/identities`, "POST", { subject, userId });
                    setNotice("Identity mapped");
                    setSubject("");
                    setUserId("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Map identity
              </Button>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
