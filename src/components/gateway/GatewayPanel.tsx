"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { gatewayPolicy, type GatewayPolicy } from "@/core/gateway/model";
import type { gatewaySnapshot } from "@/server/gateway";

type Snapshot = ReturnType<typeof gatewaySnapshot>;
type Route = Snapshot["routes"][number];
async function call<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: data === undefined ? {} : { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Gateway operation failed");
  return result;
}
const initialPolicy = () => JSON.stringify(gatewayPolicy.parse({}), null, 2);
const inputClass = "mt-1 w-full rounded border bg-background px-3 py-2 text-sm";
const buttonClass = "rounded border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50";
export function GatewayPanel() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]),
    [workspaceId, setWorkspaceId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [providerName, setProviderName] = useState(""),
    [baseUrl, setBaseUrl] = useState(""),
    [secretName, setSecretName] = useState(""),
    [credential, setCredential] = useState("");
  const [injectionType, setInjectionType] = useState<"bearer" | "header" | "basic" | "query">("bearer"),
    [injectionName, setInjectionName] = useState("");
  const [routeId, setRouteId] = useState<string | null>(null),
    [routeName, setRouteName] = useState(""),
    [apiId, setApiId] = useState(""),
    [kind, setKind] = useState<"api" | "llm" | "mcp">("api"),
    [upstreamPrefix, setUpstreamPrefix] = useState(""),
    [enabled, setEnabled] = useState(false),
    [policyText, setPolicyText] = useState(initialPolicy);
  const [modelsText, setModelsText] = useState(""),
    [toolsText, setToolsText] = useState("");
  const [grantApiId, setGrantApiId] = useState(""),
    [consumerId, setConsumerId] = useState(""),
    [tokenId, setTokenId] = useState("");
  useEffect(() => {
    let active = true;
    call<{ id: string; name: string }[]>("/api/workspaces")
      .then((rows) => {
        if (active) {
          setWorkspaces(rows);
          setWorkspaceId(rows[0]?.id ?? "");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const result = await call<Snapshot>(`/api/gateway?workspaceId=${encodeURIComponent(workspaceId)}`);
    setSnapshot(result);
  }, [workspaceId]);
  useEffect(() => {
    let active = true;
    if (workspaceId)
      call<Snapshot>(`/api/gateway?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then((result) => {
          if (active) setSnapshot(result);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const resetRoute = () => {
    setRouteId(null);
    setRouteName("");
    setApiId("");
    setKind("api");
    setUpstreamPrefix("");
    setEnabled(false);
    setPolicyText(initialPolicy());
    setModelsText("");
    setToolsText("");
  };
  function editRoute(route: Route) {
    setRouteId(route.id);
    setRouteName(route.name);
    setApiId(route.apiId);
    setKind(route.kind);
    setUpstreamPrefix(route.upstreamPrefix);
    setEnabled(route.enabled);
    setPolicyText(JSON.stringify(route.policy, null, 2));
    setModelsText(route.policy.allowedModels.join(", "));
    setToolsText(route.policy.allowedMcpTools.join(", "));
  }
  let policy: GatewayPolicy | null = null;
  try {
    policy = gatewayPolicy.parse(JSON.parse(policyText));
  } catch {
    /* Invalid policy remains editable in the advanced field. */
  }
  function updatePolicy(key: keyof GatewayPolicy, value: unknown) {
    try {
      setPolicyText(JSON.stringify({ ...JSON.parse(policyText), [key]: value }, null, 2));
    } catch {
      setError("Correct the advanced policy JSON first.");
    }
  }
  return (
    <main className="mx-auto max-w-6xl space-y-7 p-6 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/" className="text-sm underline">
            Back to Postbox
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Managed gateway</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Route API, model and MCP traffic through scoped provider credentials, limits and a shared audit
            trail.
          </p>
        </div>
        <label className="text-sm">
          Workspace
          <select
            aria-label="Gateway workspace"
            className={inputClass}
            value={workspaceId}
            disabled={busy}
            onChange={(e) => {
              resetRoute();
              setSnapshot(null);
              setGrantApiId("");
              setConsumerId("");
              setTokenId("");
              setCredential("");
              setWorkspaceId(e.target.value);
            }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3 text-destructive">
          {error}
        </p>
      )}
      {!snapshot ? (
        <p>Loading gateway…</p>
      ) : (
        <>
          <section aria-label="Gateway health" className="rounded border p-4">
            <div className="flex flex-wrap items-center gap-6">
              <strong>
                {snapshot.health.enabled ? "Gateway enabled" : "Gateway disabled on this server"}
              </strong>
              <span>{snapshot.health.ready} routes ready</span>
              <span>
                {snapshot.health.recentCalls} retained recent calls · {snapshot.health.recentErrors} errors or
                denials
              </span>
              <button className={buttonClass} disabled={busy} onClick={() => void action(refresh)}>
                Refresh status
              </button>
            </div>
            {(!snapshot.health.enabled || !snapshot.health.authenticated) && (
              <p className="mt-2 text-sm">
                An administrator can enable serving with GATEWAY_ENABLED=true. Configure an account or
                recovery authentication before sending traffic.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Health reflects configuration and retained calls. Refreshing status does not send an upstream
              request.
            </p>
          </section>
          <section aria-labelledby="providers-title" className="space-y-3">
            <h2 id="providers-title" className="text-lg font-semibold">
              Providers
            </h2>
            <p className="text-sm text-muted-foreground">
              Provider credentials stay in the encrypted workspace vault. Existing broker APIs can also be
              used as providers.
            </p>
            {snapshot.providers.length === 0 && <p>No providers configured.</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {snapshot.providers.map((provider) => (
                <article key={provider.id} className="rounded border p-4">
                  <div className="flex justify-between gap-2">
                    <h3 className="font-medium">{provider.name}</h3>
                    <span className="text-xs">
                      {provider.enabled ? "Enabled" : "Disabled"} · credential {provider.secretState}
                    </span>
                  </div>
                  <p className="my-2 break-all text-sm">{provider.baseUrl}</p>
                  <p className="text-xs text-muted-foreground">
                    Vault: {provider.secretName} · authentication: {provider.injection.type}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {snapshot.canManage ? (
                      <>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              call(`/api/broker/apis/${provider.id}`, "PATCH", {
                                enabled: !provider.enabled,
                              }),
                            )
                          }
                        >
                          {provider.enabled ? "Disable provider" : "Enable provider"}
                        </button>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => {
                            setGrantApiId(provider.id);
                            setConsumerId(snapshot.consumerId ?? "");
                          }}
                        >
                          Grant access
                        </button>
                      </>
                    ) : (
                      <button
                        className={buttonClass}
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            call(`/api/broker/apis/${provider.id}/request`, "POST", {
                              reason: "Gateway access",
                            }),
                          )
                        }
                      >
                        Request access
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {snapshot.canManage && (
              <details className="rounded border p-4">
                <summary className="cursor-pointer font-medium">Add provider</summary>
                <form
                  aria-label="Add provider"
                  className="mt-4 grid gap-4 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const injection =
                        injectionType === "header"
                          ? { type: "header", name: injectionName }
                          : injectionType === "query"
                            ? { type: "query", name: injectionName }
                            : injectionType === "basic"
                              ? { type: "basic", username: injectionName }
                              : { type: "bearer" };
                      await call("/api/gateway/providers", "POST", {
                        workspaceId,
                        name: providerName,
                        baseUrl,
                        secretName,
                        injection,
                        ...(credential ? { credentialValue: credential } : {}),
                      });
                      setCredential("");
                      setProviderName("");
                      setBaseUrl("");
                      setSecretName("");
                    });
                  }}
                >
                  <label>
                    Provider name
                    <input
                      required
                      aria-label="Provider name"
                      className={inputClass}
                      value={providerName}
                      onChange={(e) => setProviderName(e.target.value)}
                    />
                  </label>
                  <label>
                    Base URL
                    <input
                      required
                      type="url"
                      aria-label="Provider base URL"
                      className={inputClass}
                      placeholder="https://provider.example/v1"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Vault secret name
                    <input
                      required
                      aria-label="Provider vault secret"
                      className={inputClass}
                      value={secretName}
                      onChange={(e) => setSecretName(e.target.value)}
                    />
                  </label>
                  <label>
                    Credential (leave empty to use the existing vault secret)
                    <input
                      type="password"
                      autoComplete="off"
                      aria-label="Provider credential"
                      className={inputClass}
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                    />
                  </label>
                  <label>
                    Authentication
                    <select
                      aria-label="Provider authentication"
                      className={inputClass}
                      value={injectionType}
                      onChange={(e) => setInjectionType(e.target.value as typeof injectionType)}
                    >
                      <option value="bearer">Bearer</option>
                      <option value="header">Header</option>
                      <option value="basic">Basic</option>
                      <option value="query">Query parameter</option>
                    </select>
                  </label>
                  {injectionType !== "bearer" && (
                    <label>
                      {injectionType === "basic" ? "Username" : "Header or parameter name"}
                      <input
                        required
                        className={inputClass}
                        value={injectionName}
                        onChange={(e) => setInjectionName(e.target.value)}
                      />
                    </label>
                  )}
                  <button className={buttonClass} disabled={busy}>
                    Create provider
                  </button>
                </form>
              </details>
            )}
          </section>
          <section aria-labelledby="routes-title" className="space-y-3">
            <h2 id="routes-title" className="text-lg font-semibold">
              Routes and quotas
            </h2>
            {snapshot.routes.length === 0 && (
              <p>No routes configured. New routes start disabled until you enable them.</p>
            )}
            {snapshot.routes.map((route) => (
              <article key={route.id} className="rounded border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-medium">
                      {route.name}{" "}
                      <span className="text-xs text-muted-foreground">
                        {route.kind.toUpperCase()} · {route.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </h3>
                    <p className="mt-1 text-sm">
                      {route.provider.name} · {route.policy.requestsPerMinute}/minute ·{" "}
                      {route.policy.requestsPerDay}/day
                    </p>
                  </div>
                  {snapshot.canManage && (
                    <div className="flex gap-2">
                      <button className={buttonClass} onClick={() => editRoute(route)}>
                        Edit route
                      </button>
                      <button
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Delete gateway route “${route.name}”?`))
                            void action(() => call(`/api/gateway/routes/${route.id}`, "DELETE"));
                        }}
                      >
                        Delete route
                      </button>
                    </div>
                  )}
                </div>
                <code className="mt-3 block break-all text-sm">{route.endpoint}</code>
                <p className="mt-2 text-xs text-muted-foreground">
                  Send a Postbox API token as Authorization: Bearer and your approved grant ID as
                  X-Postbox-Grant. Append the provider-relative path to this endpoint.
                </p>
              </article>
            ))}
            {snapshot.canManage && (
              <form
                aria-label="Route configuration"
                className="grid gap-4 rounded border p-4 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    const parsed = gatewayPolicy.parse(JSON.parse(policyText));
                    const input = { name: routeName, apiId, kind, upstreamPrefix, enabled, policy: parsed };
                    await call(
                      routeId ? `/api/gateway/routes/${routeId}` : "/api/gateway/routes",
                      routeId ? "PUT" : "POST",
                      routeId ? input : { ...input, workspaceId },
                    );
                    resetRoute();
                  });
                }}
              >
                <h3 className="font-medium sm:col-span-2">{routeId ? "Edit route" : "Add route"}</h3>
                <label>
                  Route name
                  <input
                    required
                    aria-label="Route name"
                    className={inputClass}
                    value={routeName}
                    onChange={(e) => setRouteName(e.target.value)}
                  />
                </label>
                <label>
                  Provider
                  <select
                    required
                    aria-label="Route provider"
                    className={inputClass}
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value)}
                  >
                    <option value="">Choose provider</option>
                    {snapshot.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Route type
                  <select
                    aria-label="Route type"
                    className={inputClass}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                  >
                    <option value="api">API</option>
                    <option value="llm">LLM</option>
                    <option value="mcp">MCP</option>
                  </select>
                </label>
                <label>
                  Upstream path prefix
                  <input
                    aria-label="Upstream path prefix"
                    className={inputClass}
                    placeholder="/v1 or /mcp (optional)"
                    value={upstreamPrefix}
                    onChange={(e) => setUpstreamPrefix(e.target.value)}
                  />
                </label>
                <label>
                  Requests per minute
                  <input
                    type="number"
                    min="1"
                    aria-label="Requests per minute"
                    className={inputClass}
                    value={policy?.requestsPerMinute ?? ""}
                    onChange={(e) => updatePolicy("requestsPerMinute", Number(e.target.value))}
                  />
                </label>
                <label>
                  Requests per day
                  <input
                    type="number"
                    min="1"
                    aria-label="Requests per day"
                    className={inputClass}
                    value={policy?.requestsPerDay ?? ""}
                    onChange={(e) => updatePolicy("requestsPerDay", Number(e.target.value))}
                  />
                </label>
                {kind === "llm" && (
                  <>
                    <label>
                      Allowed models (comma-separated; empty allows all)
                      <input
                        aria-label="Allowed models"
                        className={inputClass}
                        value={modelsText}
                        onChange={(e) => {
                          setModelsText(e.target.value);
                          updatePolicy(
                            "allowedModels",
                            e.target.value
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          );
                        }}
                      />
                    </label>
                    <label>
                      Maximum output tokens
                      <input
                        type="number"
                        min="1"
                        aria-label="Maximum output tokens"
                        className={inputClass}
                        value={policy?.maxOutputTokens ?? ""}
                        onChange={(e) => updatePolicy("maxOutputTokens", Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
                {kind === "mcp" && (
                  <label className="sm:col-span-2">
                    Allowed tools (comma-separated; empty allows all)
                    <input
                      aria-label="Allowed MCP tools"
                      className={inputClass}
                      value={toolsText}
                      onChange={(e) => {
                        setToolsText(e.target.value);
                        updatePolicy(
                          "allowedMcpTools",
                          e.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        );
                      }}
                    />
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                  Enable route
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={policy?.allowStreaming ?? false}
                    onChange={(e) => updatePolicy("allowStreaming", e.target.checked)}
                  />
                  Allow streaming
                </label>
                <details className="sm:col-span-2">
                  <summary className="cursor-pointer text-sm">
                    Advanced policy: methods, paths, headers, deadlines and byte limits
                  </summary>
                  <textarea
                    aria-label="Advanced gateway policy"
                    className={`${inputClass} h-64 font-mono text-xs`}
                    value={policyText}
                    onChange={(e) => {
                      setPolicyText(e.target.value);
                      try {
                        const next = gatewayPolicy.parse(JSON.parse(e.target.value));
                        setModelsText(next.allowedModels.join(", "));
                        setToolsText(next.allowedMcpTools.join(", "));
                      } catch {
                        /* Keep invalid JSON editable until corrected. */
                      }
                    }}
                  />
                </details>
                <div className="flex gap-2 sm:col-span-2">
                  <button className={buttonClass} disabled={busy || !policy}>
                    {routeId ? "Save route" : "Create route"}
                  </button>
                  {routeId && (
                    <button type="button" className={buttonClass} onClick={resetRoute}>
                      Cancel edit
                    </button>
                  )}
                </div>
              </form>
            )}
          </section>
          <section aria-labelledby="grants-title" className="space-y-3">
            <h2 id="grants-title" className="text-lg font-semibold">
              Consumer access
            </h2>
            <p className="text-sm text-muted-foreground">
              Grants belong to a consumer identity and can be bound to one API key. Expiry, revocation and
              provider disablement apply before each call.
            </p>
            {snapshot.canManage && (
              <form
                aria-label="Grant provider access"
                className="grid gap-3 rounded border p-4 sm:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(() =>
                    call(`/api/gateway/providers/${grantApiId}/grant`, "POST", {
                      consumerId: consumerId || snapshot.consumerId,
                      ...(tokenId ? { tokenId } : {}),
                      expiresInSec: 86400,
                    }),
                  );
                }}
              >
                <label>
                  Provider
                  <select
                    required
                    aria-label="Grant provider"
                    className={inputClass}
                    value={grantApiId}
                    onChange={(e) => setGrantApiId(e.target.value)}
                  >
                    <option value="">Choose provider</option>
                    {snapshot.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Consumer
                  <select
                    aria-label="Grant consumer"
                    className={inputClass}
                    value={consumerId}
                    onChange={(e) => setConsumerId(e.target.value)}
                  >
                    <option value="">Current identity</option>
                    {snapshot.members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.username}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Restrict to API key ID (optional)
                  <input
                    aria-label="Grant API key ID"
                    className={inputClass}
                    value={tokenId}
                    onChange={(e) => setTokenId(e.target.value)}
                  />
                </label>
                <button className={buttonClass} disabled={busy}>
                  Grant for 24 hours
                </button>
              </form>
            )}
            {snapshot.grants.map((grant) => (
              <article
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded border p-3 text-sm"
              >
                <div>
                  <strong>{grant.apiName}</strong> · {grant.consumerName} · {grant.status}
                  {grant.tokenBound && " · bound to an API key"}
                  <code className="mt-1 block break-all text-xs">{grant.id}</code>
                </div>
                <div className="flex gap-2">
                  {grant.status === "pending" && snapshot.canManage && (
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          call(`/api/broker/grants/${grant.id}/approve`, "POST", { expiresInSec: 86400 }),
                        )
                      }
                    >
                      Approve access
                    </button>
                  )}
                  {grant.status === "approved" && (
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() =>
                        void action(() => call(`/api/broker/grants/${grant.id}/revoke`, "POST", {}))
                      }
                    >
                      Revoke access
                    </button>
                  )}
                </div>
              </article>
            ))}
          </section>
          <section aria-labelledby="traces-title" className="space-y-3">
            <h2 id="traces-title" className="text-lg font-semibold">
              Recent gateway traces
            </h2>
            <p className="text-xs text-muted-foreground">
              Shows up to 200 of the last 1,000 retained workspace calls. Payloads, URLs, query values,
              headers and credentials are excluded.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {["Time", "Route", "Method", "Status", "Outcome", "Duration", "Response bytes"].map(
                      (label) => (
                        <th className="border-b p-2" key={label}>
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {snapshot.traces.map((trace) => (
                    <tr key={trace.id}>
                      <td className="border-b p-2">{new Date(trace.startedAt).toLocaleString()}</td>
                      <td className="border-b p-2">
                        {snapshot.routes.find((r) => r.id === trace.routeId)?.name ?? "Deleted route"}
                      </td>
                      <td className="border-b p-2">{trace.method}</td>
                      <td className="border-b p-2">{trace.status ?? "—"}</td>
                      <td className="border-b p-2">
                        {trace.outcome} ({trace.code})
                      </td>
                      <td className="border-b p-2">{trace.durationMs} ms</td>
                      <td className="border-b p-2">{trace.responseBytes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {snapshot.traces.length === 0 && <p>No gateway calls recorded.</p>}
          </section>
        </>
      )}
    </main>
  );
}
