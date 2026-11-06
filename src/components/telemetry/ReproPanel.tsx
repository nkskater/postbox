"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { planRepro, type FailureEvidence, type ReproGap } from "@/core/telemetry/repro";

const severityClass: Record<ReproGap["severity"], string> = {
  blocking: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
};

/**
 * Maps one captured production failure onto a target environment and opens an editable,
 * unsent request draft. The original evidence is shown read-only and copied into the draft.
 */
export function ReproPanel({ evidence, onClose }: { evidence: FailureEvidence; onClose: () => void }) {
  const environments = useApp((s) => s.environments),
    activeEnvironmentId = useApp((s) => s.environmentId);
  const [environmentId, setEnvironmentId] = useState<string>(activeEnvironmentId ?? ""),
    [variables, setVariables] = useState<{ id: string; keys: string[] } | null>(null),
    [baseUrl, setBaseUrl] = useState("{{baseUrl}}"),
    [path, setPath] = useState(""),
    [pathValues, setPathValues] = useState<string[]>([]),
    [acknowledged, setAcknowledged] = useState(false),
    [activate, setActivate] = useState(true),
    [error, setError] = useState("");

  useEffect(() => {
    if (!environmentId) return;
    let active = true;
    api.environments
      .get(environmentId)
      .then((env) => {
        if (active)
          setVariables({ id: environmentId, keys: env.variables.filter((v) => v.enabled).map((v) => v.key) });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [environmentId]);

  const plan = useMemo(() => {
    try {
      return planRepro(evidence, {
        baseUrl,
        path: path || undefined,
        pathValues,
        environmentId: environmentId || null,
        environmentVariables: environmentId && variables?.id === environmentId ? variables.keys : undefined,
        acknowledgeSideEffects: acknowledged,
      });
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }, [evidence, baseUrl, path, pathValues, environmentId, variables, acknowledged]);

  function open() {
    if (plan instanceof Error || !plan.draft) return;
    const app = useApp.getState();
    if (environmentId && activate && environmentId !== app.environmentId) app.setEnvironment(environmentId);
    app.openDraft(plan.draft);
  }

  const routeParts = evidence.route.split("/").filter(Boolean);
  return (
    <section aria-label="Reproduce failure" className="border rounded p-3 space-y-3 text-xs">
      <div className="flex gap-3 items-center">
        <h4 className="font-semibold text-sm">Reproduce failure</h4>
        <Button size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <dl
        aria-label="Original evidence"
        className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 break-all"
      >
        <dt>Endpoint</dt>
        <dd>
          {evidence.method} {evidence.route} ({evidence.routeSource} route)
        </dd>
        <dt>Result</dt>
        <dd>
          HTTP {evidence.status ?? "unknown"} · {Number(evidence.durationMs.toFixed(2))} ms
        </dd>
        <dt>Observed</dt>
        <dd>
          {new Date(evidence.at).toLocaleString()} · {evidence.service} · {evidence.environment}
        </dd>
        <dt>Trace</dt>
        <dd>
          {evidence.traceId} · span {evidence.spanId}
        </dd>
      </dl>
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          Target environment
          <select
            aria-label="Target environment"
            className="block w-full border rounded p-2 bg-background"
            value={environmentId}
            onChange={(e) => {
              setEnvironmentId(e.target.value);
              setVariables(null);
              setError("");
            }}
          >
            <option value="">No environment</option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Base URL (replaces the discarded production host)
          <Input aria-label="Target base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      </div>
      {evidence.route === "/[unmapped]" ? (
        <label className="block">
          Path to reproduce
          <Input
            aria-label="Path to reproduce"
            placeholder="/orders/{{orderId}}"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
      ) : (
        !(plan instanceof Error) &&
        plan.placeholders.length > 0 && (
          <fieldset className="space-y-2">
            <legend>Route placeholders (production values were redacted)</legend>
            {plan.placeholders.map((p) => (
              <label key={p.index} className="block">
                /{routeParts.slice(0, p.segment).join("/")}/<strong>{routeParts[p.segment]}</strong>{" "}
                {p.kind === "segment" ? "(non-allowlisted path word)" : "(identifier)"}
                <Input
                  aria-label={`Route placeholder ${p.index + 1}`}
                  placeholder="value or {{variable}}"
                  value={pathValues[p.index] ?? ""}
                  onChange={(e) =>
                    setPathValues((values) => {
                      const next = [...values];
                      next[p.index] = e.target.value;
                      return next;
                    })
                  }
                />
              </label>
            ))}
          </fieldset>
        )
      )}
      {plan instanceof Error ? (
        <p className="text-destructive">{plan.message}</p>
      ) : (
        <>
          {plan.sideEffectful && (
            <label className="flex gap-2 items-start">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand {evidence.method} can create, change or delete data in the target environment.
              </span>
            </label>
          )}
          <ul aria-label="Missing or redacted fields" className="space-y-1">
            {plan.gaps.map((gap, i) => (
              <li key={i} className={severityClass[gap.severity]}>
                [{gap.severity}] {gap.field}: {gap.message}
              </li>
            ))}
          </ul>
          {plan.url && (
            <p className="break-all">
              Draft URL: <code>{plan.url}</code>
            </p>
          )}
        </>
      )}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex gap-3 items-center flex-wrap">
        {environmentId && environmentId !== activeEnvironmentId && (
          <label className="flex gap-2 items-center">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
            Make the target environment active
          </label>
        )}
        <Button size="sm" disabled={plan instanceof Error || !plan.ready} onClick={open}>
          Open draft (not sent)
        </Button>
      </div>
    </section>
  );
}
