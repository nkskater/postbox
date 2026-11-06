"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { telemetryConfig, type TelemetryConfig, type TelemetryQuery } from "@/core/telemetry/model";
import type { getTelemetryMetrics, getTelemetryEndpoint, listTelemetrySources } from "@/server/telemetry";
type Source = ReturnType<typeof listTelemetrySources>[number];
type Metrics = ReturnType<typeof getTelemetryMetrics>;
type Endpoint = ReturnType<typeof getTelemetryEndpoint>;
const number = (value: number | null, suffix = "") =>
  value === null ? "—" : `${Number(value.toFixed(2))}${suffix}`;
const localDate = (time: number) =>
  new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function download(value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })),
    a = document.createElement("a");
  a.href = url;
  a.download = "postbox-telemetry.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TelemetryPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <Dashboard key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function Dashboard({ workspaceId }: { workspaceId: string }) {
  const [sources, setSources] = useState<Source[]>([]),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<Source | null | undefined>(),
    [credential, setCredential] = useState<{ id: string; token: string } | null>(null);
  const [sourceId, setSourceId] = useState(""),
    [service, setService] = useState(""),
    [environment, setEnvironment] = useState(""),
    [search, setSearch] = useState(""),
    [errorsOnly, setErrorsOnly] = useState(false);
  const [from, setFrom] = useState(() => localDate(Date.now() - 3600000)),
    [to, setTo] = useState(() => localDate(Date.now() + 60000)),
    [offset, setOffset] = useState(0);
  const [result, setResult] = useState<Metrics | null>(null),
    [detail, setDetail] = useState<Endpoint | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api.telemetry
      .sources(workspaceId)
      .then((rows) => {
        if (active) setSources(rows);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, [workspaceId, revision]);
  const query: TelemetryQuery = {
    from: new Date(from).getTime(),
    to: new Date(to).getTime(),
    sourceId: sourceId || undefined,
    service: service || undefined,
    environment: environment || undefined,
    search,
    errorsOnly,
    offset,
    limit: 25,
  };
  useEffect(() => {
    let active = true;
    const query: TelemetryQuery = {
      from: new Date(from).getTime(),
      to: new Date(to).getTime(),
      sourceId: sourceId || undefined,
      service: service || undefined,
      environment: environment || undefined,
      search,
      errorsOnly,
      offset,
      limit: 25,
    };
    api.telemetry
      .metrics(workspaceId, query)
      .then((data) => {
        if (active) {
          setResult(data);
          setLoading(false);
          setError("");
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e.message));
          setLoading(false);
          setResult(null);
        }
      });
    return () => {
      active = false;
    };
  }, [workspaceId, revision, from, to, sourceId, service, environment, search, errorsOnly, offset]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function filter(fn: () => void) {
    fn();
    setOffset(0);
    setRevision((v) => v + 1);
    setDetail(null);
    setLoading(true);
  }
  return (
    <div className="h-full overflow-auto p-5 space-y-5 text-sm">
      <header className="flex flex-wrap gap-3 items-center">
        <h1 className="text-xl font-semibold">Production telemetry</h1>
        <Button
          variant="outline"
          onClick={() => {
            setRevision((v) => v + 1);
            setDetail(null);
            setLoading(true);
          }}
        >
          Refresh
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setCredential(null);
            setEditing(null);
          }}
        >
          Add telemetry source
        </Button>
      </header>
      <p className="text-muted-foreground">
        Opt-in OTLP/HTTP JSON server traces. Metrics describe retained sampled observations, not total
        production traffic. Error = HTTP 4xx/5xx or span error status. No request bodies, headers, query
        strings or error messages are stored.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {credential && (
        <section aria-label="New ingestion credential" className="border rounded p-4 space-y-2">
          <strong>Copy this credential now. It is shown only once.</strong>
          <p>
            Configure your exporter before enabling the source. Rotation immediately invalidates the previous
            credential.
          </p>
          <pre className="whitespace-pre-wrap break-all select-all">{`POST ${window.location.origin}/api/telemetry/ingest/${credential.id}/v1/traces\nAuthorization: Bearer ${credential.token}\nContent-Type: application/json`}</pre>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(credential.token)
                .catch(() => setError("Could not copy; select the credential above."))
            }
          >
            Copy credential
          </Button>
          <Button variant="outline" onClick={() => setCredential(null)}>
            Dismiss credential
          </Button>
        </section>
      )}
      {editing !== undefined && (
        <SourceForm
          key={editing?.id ?? "new"}
          source={editing}
          busy={busy}
          onCancel={() => setEditing(undefined)}
          onSave={(config) =>
            void action(async () => {
              if (editing) await api.telemetry.save(editing.id, editing.revision, config);
              else {
                const created = await api.telemetry.create(workspaceId, config);
                setCredential({ id: created.source.id, token: created.token });
              }
              setEditing(undefined);
            })
          }
        />
      )}
      <section aria-label="Telemetry sources" className="space-y-3">
        <h2 className="font-semibold">Sources</h2>
        {sources.length === 0 && (
          <p>No sources yet. Add a disabled source, configure a JSON trace exporter, then enable intake.</p>
        )}
        {sources.map((source) => (
          <article key={source.id} className="border rounded p-3 space-y-2">
            <div className="flex flex-wrap gap-3 items-center">
              <strong>{source.config.name}</strong>
              <span>
                {source.config.enabled ? "Enabled" : "Disabled"} · {source.config.serviceName} ·{" "}
                {source.config.environment}
              </span>
              <span>
                {source.config.sampleRate * 100}% sampling · {source.config.retentionDays} days /{" "}
                {source.config.maxObservations} observations
              </span>
            </div>
            <p className="text-xs break-all">
              Source {source.id} · Revision {source.revision} · Last intake{" "}
              {source.lastReceivedAt ? new Date(source.lastReceivedAt).toLocaleString() : "never"}
            </p>
            {source.lastIntake && (
              <p className="text-xs">
                Received {source.lastIntake.received} · accepted {source.lastIntake.accepted} · sampled out{" "}
                {source.lastIntake.sampledOut} · ignored {source.lastIntake.ignored} · rejected{" "}
                {source.lastIntake.rejected} · duplicates {source.lastIntake.duplicates} · evicted{" "}
                {source.lastIntake.evicted}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setCredential(null);
                  setEditing(source);
                }}
              >
                Edit source
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Rotate ingestion credential? The old credential stops working immediately.",
                    )
                  )
                    void action(async () => {
                      const r = await api.telemetry.rotate(source.id, source.revision);
                      setCredential({ id: source.id, token: r.token });
                    });
                }}
              >
                Rotate credential
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete all retained observations for this source?"))
                    void action(async () => {
                      await api.telemetry.purge(source.id);
                      setDetail(null);
                    });
                }}
              >
                Purge observations
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this source and all its observations?"))
                    void action(async () => {
                      await api.telemetry.delete(source.id);
                      setDetail(null);
                      setCredential(null);
                      if (editing?.id === source.id) setEditing(undefined);
                      if (sourceId === source.id) setSourceId("");
                    });
                }}
              >
                Delete source
              </Button>
            </div>
          </article>
        ))}
      </section>
      <details className="border rounded p-3">
        <summary className="cursor-pointer font-medium">Connect a service</summary>
        <div className="space-y-2 pt-3">
          <p>
            Use an OpenTelemetry exporter that supports OTLP/HTTP JSON, or send JSON traces from your
            collector to the source URL above. Binary protobuf and gRPC exporters are unsupported. The
            resource <code>service.name</code> must exactly match the configured service name; only SERVER
            spans with HTTP metadata are accepted. Configure the Authorization header with the dedicated
            source credential.
          </p>
          <p>
            POST at most 1,000 spans and 2 MiB per batch (compressed and decoded); gzip supported; 120
            batches/minute/source. The source environment is fixed by configuration. HTTP route templates are
            preferred; paths are inferred otherwise. Add only public literal path words to the allowlist: all
            other segments become placeholders. Never add customer names or secrets.
          </p>
          <p>
            Retention is capped at 30 days, 5,000 observations/source and 20,000/workspace. Older observations
            are evicted first. Disabling stops new intake; purge deletes retained observations. Backups omit
            observations and credentials; restored sources require credential rotation and explicit enabling.
          </p>
          <a
            className="underline"
            href="https://opentelemetry.io/docs/specs/otlp/"
            target="_blank"
            rel="noreferrer"
          >
            OTLP protocol documentation
          </a>
        </div>
      </details>
      <section aria-label="Telemetry filters" className="border rounded p-3 flex flex-wrap gap-3 items-end">
        <label>
          Source
          <select
            aria-label="Telemetry source filter"
            className="block border rounded p-2 bg-background"
            value={sourceId}
            onChange={(e) => filter(() => setSourceId(e.target.value))}
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.config.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service
          <Input value={service} onChange={(e) => filter(() => setService(e.target.value))} />
        </label>
        <label>
          Environment
          <Input value={environment} onChange={(e) => filter(() => setEnvironment(e.target.value))} />
        </label>
        <label>
          Route contains
          <Input value={search} onChange={(e) => filter(() => setSearch(e.target.value))} />
        </label>
        <label>
          From
          <Input type="datetime-local" value={from} onChange={(e) => filter(() => setFrom(e.target.value))} />
        </label>
        <label>
          To (exclusive)
          <Input type="datetime-local" value={to} onChange={(e) => filter(() => setTo(e.target.value))} />
        </label>
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => filter(() => setErrorsOnly(e.target.checked))}
          />
          Endpoints with errors
        </label>
        <Button
          variant="outline"
          onClick={() =>
            filter(() => {
              setFrom(localDate(Date.now() - 3600000));
              setTo(localDate(Date.now() + 60000));
            })
          }
        >
          Last hour
        </Button>
      </section>
      {loading ? (
        <p role="status">Loading telemetry…</p>
      ) : (
        result && (
          <section aria-label="Endpoint inventory" className="space-y-3">
            <div className="flex flex-wrap gap-4 items-center">
              <h2 className="font-semibold">Endpoint inventory</h2>
              <Button size="sm" variant="outline" onClick={() => download(result)}>
                Export metrics JSON
              </Button>
            </div>
            <p>
              {result.sampledRequests} sampled requests · {result.totalEndpoints} endpoints · {result.errors}{" "}
              errors · {number(result.errorRate, "% errors")} · p50 {number(result.p50Ms, " ms")} · p95{" "}
              {number(result.p95Ms, " ms")} · p99 {number(result.p99Ms, " ms")}
            </p>
            {!result.sampledRequests && (
              <p>
                No retained observations in this window. Check source enablement, matching service.name,
                exporter format and last intake counts.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr>
                    {[
                      "Endpoint",
                      "Source / service / environment",
                      "Sampled requests",
                      "Error rate",
                      "p50 / p95 / p99 ms",
                      "Sampling",
                      "Last seen",
                    ].map((h) => (
                      <th className="p-2 border-b" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.endpoints.map((e) => (
                    <tr key={e.id}>
                      <td className="p-2 border-b">
                        <button
                          className="underline text-primary text-left break-all"
                          onClick={() =>
                            void action(async () => {
                              setDetail(await api.telemetry.endpoint(workspaceId, e.id, query));
                            })
                          }
                        >
                          {e.method} {e.route}
                        </button>
                        <p>
                          {e.routeSources.template} template · {e.routeSources.path} inferred ·{" "}
                          {e.routeSources.unknown} unmapped
                        </p>
                      </td>
                      <td className="p-2 border-b break-all">
                        {sources.find((s) => s.id === e.sourceId)?.config.name ?? e.sourceId}
                        <br />
                        {e.service} / {e.environment}
                      </td>
                      <td className="p-2 border-b">{e.sampledRequests}</td>
                      <td className="p-2 border-b">
                        {number(e.errorRate, "%")} ({e.errors})
                      </td>
                      <td className="p-2 border-b">
                        {number(e.p50Ms)} / {number(e.p95Ms)} / {number(e.p99Ms)}
                      </td>
                      <td className="p-2 border-b">{e.sampleRates.map((v) => `${v * 100}%`).join(", ")}</td>
                      <td className="p-2 border-b">{new Date(e.lastSeen).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 items-center">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - 25));
                  setDetail(null);
                  setLoading(true);
                }}
              >
                Previous endpoints
              </Button>
              <span>
                {Math.min(offset + 1, result.totalEndpoints)}–{Math.min(offset + 25, result.totalEndpoints)}{" "}
                of {result.totalEndpoints}
              </span>
              <Button
                variant="outline"
                disabled={offset + 25 >= result.totalEndpoints}
                onClick={() => {
                  setOffset(offset + 25);
                  setDetail(null);
                  setLoading(true);
                }}
              >
                Next endpoints
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer">Latency distribution and time buckets</summary>
              <div className="space-y-2 p-2">
                <p>
                  Exact nearest-rank percentiles over retained samples; histogram upper bounds are exclusive.
                </p>
                {result.histogram.map((b) => (
                  <div key={b.fromMs} className="flex gap-3 items-center">
                    <span className="w-32">
                      {b.fromMs}–{b.toMs ?? "∞"} ms
                    </span>
                    <meter
                      className="w-48"
                      min={0}
                      max={Math.max(1, result.sampledRequests)}
                      value={b.count}
                    />
                    <span>{b.count}</span>
                  </div>
                ))}
                <table className="text-xs w-full text-left">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Samples</th>
                      <th>Errors</th>
                      <th>p95 ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.timeline.map((b) => (
                      <tr key={b.from}>
                        <td>{new Date(b.from).toLocaleString()}</td>
                        <td>{b.sampledRequests}</td>
                        <td>{number(b.errorRate, "%")}</td>
                        <td>{number(b.p95Ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        )
      )}
      {detail && (
        <section aria-label="Endpoint detail" className="border rounded p-4 space-y-3">
          <div className="flex gap-3">
            <h2 className="font-semibold">
              {detail.method} {detail.route}
            </h2>
            <Button size="sm" variant="outline" onClick={() => setDetail(null)}>
              Close detail
            </Button>
            <Button size="sm" variant="outline" onClick={() => download(detail)}>
              Export endpoint JSON
            </Button>
          </div>
          <p>
            {detail.service} · {detail.environment} · source {detail.sourceId} · {detail.sampledRequests}{" "}
            samples · {number(detail.errorRate, "% errors")}
          </p>
          <p>
            HTTP statuses:{" "}
            {Object.entries(detail.statuses)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </p>
          <h3>Recent failed spans (up to 20)</h3>
          <p className="text-xs text-muted-foreground">
            Trace/span IDs can correlate with your tracing backend. Payloads and error messages are discarded.
          </p>
          {!detail.failedSpans.length && <p>No failed spans.</p>}
          {detail.failedSpans.map((s) => (
            <article key={s.id} className="text-xs border rounded p-2 break-all">
              {new Date(s.at).toLocaleString()} · HTTP {s.status ?? "unknown"} · {number(s.durationMs, " ms")}{" "}
              · source revision {s.sourceRevision} · {s.sampleRate * 100}% sampling
              <br />
              Trace {s.traceId} · span {s.spanId}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
function SourceForm({
  source,
  busy,
  onSave,
  onCancel,
}: {
  source: Source | null;
  busy: boolean;
  onSave: (config: TelemetryConfig) => void;
  onCancel: () => void;
}) {
  const [config, setConfig] = useState(
    () => source?.config ?? telemetryConfig.parse({ name: "New source", serviceName: "placeholder" }),
  );
  const [segments, setSegments] = useState(config.staticSegments.join(", ")),
    [error, setError] = useState("");
  const update = <K extends keyof TelemetryConfig>(key: K, value: TelemetryConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));
  return (
    <form
      aria-label="Telemetry source editor"
      className="border rounded p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = telemetryConfig.safeParse({
          ...config,
          staticSegments: segments
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
        if (!parsed.success) {
          setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          return;
        }
        onSave(parsed.data);
      }}
    >
      <h2 className="font-semibold">{source ? "Edit telemetry source" : "New telemetry source"}</h2>
      <div className="flex flex-wrap gap-3">
        <label>
          Source name
          <Input
            required
            maxLength={200}
            value={config.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </label>
        <label>
          Expected service.name
          <Input
            required
            maxLength={120}
            value={config.serviceName === "placeholder" ? "" : config.serviceName}
            onChange={(e) => update("serviceName", e.target.value)}
          />
        </label>
        <label>
          Environment
          <Input
            required
            maxLength={100}
            value={config.environment}
            onChange={(e) => update("environment", e.target.value)}
          />
        </label>
        <label>
          Sampling fraction (0–1)
          <Input
            type="number"
            min={0}
            max={1}
            step="any"
            value={config.sampleRate}
            onChange={(e) => update("sampleRate", Number(e.target.value))}
          />
        </label>
        <label>
          Retention days (1–30)
          <Input
            type="number"
            min={1}
            max={30}
            value={config.retentionDays}
            onChange={(e) => update("retentionDays", Number(e.target.value))}
          />
        </label>
        <label>
          Observation cap (100–5,000)
          <Input
            type="number"
            min={100}
            max={5000}
            value={config.maxObservations}
            onChange={(e) => update("maxObservations", Number(e.target.value))}
          />
        </label>
      </div>
      <label className="block">
        Public literal path segments (comma separated)
        <Input value={segments} onChange={(e) => setSegments(e.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">
        Other path segments are replaced by :id or :segment before storage. Changing the allowlist, service or
        sampling affects future observations only.
      </p>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
        />
        Enable ingestion for this source
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save source
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
