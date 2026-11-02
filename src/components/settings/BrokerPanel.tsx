"use client";
/** Credential broker: register APIs whose credential stays in the vault, and approve who may call them. */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { useApp } from "@/stores/app";

interface Api {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  secretName: string;
  injection: {
    type: "bearer" | "header" | "basic" | "query";
    name?: string;
    prefix?: string;
    username?: string;
  };
  methods: string[];
  pathPrefixes: string[];
  enabled: boolean;
  secretState: "ok" | "missing" | "disabled" | "needs-value";
}
interface Grant {
  id: string;
  apiId: string;
  apiName: string;
  consumerName: string;
  tokenBound: boolean;
  status: "pending" | "approved" | "denied" | "revoked" | "expired";
  reason: string;
  methods: string[];
  pathPrefixes: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  reference: string;
}
interface SecretName {
  name: string;
  collectionIds: string[];
  personal: boolean;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const list = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

const describeInjection = (i: Api["injection"]) =>
  i.type === "bearer"
    ? "Authorization: Bearer"
    : i.type === "basic"
      ? `Basic auth (${i.username || "no username"})`
      : i.type === "query"
        ? `?${i.name}=`
        : `${i.name}: ${i.prefix ?? ""}…`;

export function BrokerPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  const [apis, setApis] = useState<Api[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [secrets, setSecrets] = useState<SecretName[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secretName, setSecretName] = useState("");
  const [style, setStyle] = useState<Api["injection"]["type"]>("bearer");
  const [headerName, setHeaderName] = useState("X-Api-Key");
  const [username, setUsername] = useState("");
  const [methods, setMethods] = useState("");
  const [paths, setPaths] = useState("");
  const [deciding, setDeciding] = useState<{
    id: string;
    methods: string;
    paths: string;
    hours: string;
  } | null>(null);

  const load = useCallback(() => {
    Promise.all([
      call<Api[]>(`/api/broker/apis?workspaceId=${workspaceId}`),
      call<Grant[]>(`/api/broker/grants?workspaceId=${workspaceId}`),
      call<SecretName[]>(`/api/vault?workspaceId=${workspaceId}`),
    ])
      .then(([a, g, s]) => {
        setApis(a);
        setGrants(g);
        setSecrets(s.filter((x) => !x.personal && x.collectionIds.length === 0));
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [workspaceId]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    run(async () => {
      await call("/api/broker/apis", "POST", {
        workspaceId,
        name,
        baseUrl,
        secretName,
        injection:
          style === "header"
            ? { type: "header", name: headerName }
            : style === "query"
              ? { type: "query", name: headerName }
              : style === "basic"
                ? { type: "basic", username }
                : { type: "bearer" },
        methods: list(methods.toUpperCase()),
        pathPrefixes: list(paths),
      });
      setName("");
      setBaseUrl("");
      setMethods("");
      setPaths("");
    }, "API registered");

  const approve = (d: NonNullable<typeof deciding>) =>
    run(async () => {
      await call(`/api/broker/grants/${d.id}/approve`, "POST", {
        ...(d.methods.trim() ? { methods: list(d.methods.toUpperCase()) } : {}),
        ...(d.paths.trim() ? { pathPrefixes: list(d.paths) } : {}),
        ...(d.hours.trim() ? { expiresInSec: Math.round(Number(d.hours) * 3600) } : {}),
      });
      setDeciding(null);
    }, "Access approved");

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Credential broker">
      <div>
        <h3 className="font-medium">Credential broker</h3>
        <p className="text-sm text-muted-foreground">
          Let people, service accounts and agents call an API without ever holding its credential. Register
          the API and the vault secret that authenticates it; approve who may use it, with limits. They call
          through Postbox, which adds the credential and masks it in what comes back. An access reference only
          works for the consumer it was approved for, and revoking it stops it at once.
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {apis.length === 0 ? (
        <p className="text-sm text-muted-foreground">No brokered APIs yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {apis.map((api) => {
            const mine = grants.filter((g) => g.apiId === api.id);
            return (
              <li key={api.id} className={`space-y-2 p-3 text-sm ${api.enabled ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{api.name}</span>{" "}
                    <code className="text-xs text-muted-foreground">{api.baseUrl}</code>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call(`/api/broker/apis/${api.id}/request`, "POST", {}),
                          "Access requested",
                        )
                      }
                    >
                      Request access
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call(`/api/broker/apis/${api.id}`, "PATCH", { enabled: !api.enabled }),
                          api.enabled ? "API disabled" : "API enabled",
                        )
                      }
                    >
                      {api.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => call(`/api/broker/apis/${api.id}`, "DELETE"), "API removed")
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Credential <code>{`{{vault:${api.secretName}}}`}</code> as{" "}
                  {describeInjection(api.injection)}
                  {api.secretState !== "ok" && (
                    <span className="ml-1 text-destructive">
                      ({api.secretState === "missing" ? "secret is missing" : `secret is ${api.secretState}`})
                    </span>
                  )}
                  {" · "}
                  {api.methods.length ? api.methods.join(", ") : "any method"}
                  {" · "}
                  {api.pathPrefixes.length ? api.pathPrefixes.join(", ") : "any path"}
                </div>
                {mine.length > 0 && (
                  <ul className="divide-y rounded border">
                    {mine.map((g) => (
                      <li key={g.id} className="space-y-1 p-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-medium">{g.consumerName}</span>{" "}
                            <span className="rounded border px-1">{g.status}</span>
                            {g.tokenBound && <span className="ml-1 rounded border px-1">one API key</span>}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {g.status === "pending" && (
                              <>
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => setDeciding({ id: g.id, methods: "", paths: "", hours: "" })}
                                >
                                  Review
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(
                                      () => call(`/api/broker/grants/${g.id}/deny`, "POST"),
                                      "Request denied",
                                    )
                                  }
                                >
                                  Deny
                                </Button>
                              </>
                            )}
                            {(g.status === "approved" || g.status === "pending") && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () => call(`/api/broker/grants/${g.id}/revoke`, "POST"),
                                    "Access revoked",
                                  )
                                }
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        </div>
                        {g.reason && <div className="text-muted-foreground">“{g.reason}”</div>}
                        {g.status === "approved" && (
                          <div className="text-muted-foreground">
                            Reference <code>{g.reference}</code> ·{" "}
                            {g.methods.length ? g.methods.join(", ") : "API's methods"} ·{" "}
                            {g.pathPrefixes.length ? g.pathPrefixes.join(", ") : "API's paths"} ·{" "}
                            {g.expiresAt ? `until ${formatDateTime(g.expiresAt)}` : "no expiry"} · used{" "}
                            {g.useCount}×{g.lastUsedAt ? `, last ${formatDateTime(g.lastUsedAt)}` : ""}
                          </div>
                        )}
                        {deciding?.id === g.id && (
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Input
                              className="h-7 w-40"
                              aria-label="Allowed methods"
                              placeholder="Methods (GET, POST)"
                              value={deciding.methods}
                              onChange={(e) => setDeciding({ ...deciding, methods: e.target.value })}
                            />
                            <Input
                              className="h-7 w-48"
                              aria-label="Allowed paths"
                              placeholder="Paths (/users, /orders)"
                              value={deciding.paths}
                              onChange={(e) => setDeciding({ ...deciding, paths: e.target.value })}
                            />
                            <Input
                              className="h-7 w-32"
                              aria-label="Expires after hours"
                              placeholder="Hours (blank: none)"
                              value={deciding.hours}
                              onChange={(e) => setDeciding({ ...deciding, hours: e.target.value })}
                            />
                            <Button size="sm" disabled={busy} onClick={() => void approve(deciding)}>
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setDeciding(null)}>
                              Cancel
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-medium">Register an API</h4>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-40"
            aria-label="API name"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            className="w-64"
            aria-label="Base URL"
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-label="Vault secret"
            value={secretName}
            onChange={(e) => setSecretName(e.target.value)}
          >
            <option value="">Vault secret…</option>
            {secrets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-label="How the credential is sent"
            value={style}
            onChange={(e) => setStyle(e.target.value as Api["injection"]["type"])}
          >
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
            <option value="basic">Basic auth</option>
            <option value="query">Query parameter</option>
          </select>
          {(style === "header" || style === "query") && (
            <Input
              className="w-36"
              aria-label={style === "header" ? "Header name" : "Parameter name"}
              value={headerName}
              onChange={(e) => setHeaderName(e.target.value)}
            />
          )}
          {style === "basic" && (
            <Input
              className="w-36"
              aria-label="Username"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-48"
            aria-label="Allowed methods for everyone"
            placeholder="Methods (blank: any)"
            value={methods}
            onChange={(e) => setMethods(e.target.value)}
          />
          <Input
            className="w-56"
            aria-label="Allowed paths for everyone"
            placeholder="Paths (blank: any)"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
          />
          <Button disabled={busy || !name || !baseUrl || !secretName} onClick={() => void register()}>
            Register
          </Button>
        </div>
      </div>
    </section>
  );
}
