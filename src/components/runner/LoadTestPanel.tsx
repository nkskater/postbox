"use client";
/** Load testing for a collection: choose a profile and thresholds, watch it run, read percentiles, compare tests. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { describeProfile, parseDurationSec, profileSchema, type LoadProfile } from "@/core/load/profile";
import type { LoadSnapshot } from "@/core/load/metrics";
import { parseThreshold, type Threshold, type ThresholdResult } from "@/core/load/thresholds";
import { readNdjson } from "@/lib/ndjson";
import { formatDateTime } from "@/lib/format";
import { LoadChart } from "./LoadChart";

interface Doc {
  id: string;
  name: string;
  status: string;
  profile: LoadProfile;
  startedAt: number;
  result: {
    stoppedBy: string | null;
    snapshot: LoadSnapshot;
    thresholds: ThresholdResult[];
    warnings: string[];
  } | null;
  error: string | null;
}
interface PastRun {
  id: string;
  status: string;
  startedAt: number;
  profile: LoadProfile;
  summary: {
    requests: number;
    errorRate: number;
    rps: number;
    p95: number;
    peakVus: number;
    thresholdsFailed: number;
  } | null;
}
interface Comparison {
  metrics: Record<string, { before: number; after: number; delta: number; percent: number | null }>;
}

const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="rounded border p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className={tone === "bad" ? "text-base font-medium text-destructive" : "text-base font-medium"}>
        {value}
      </div>
    </div>
  );
}

export function LoadTestPanel({ folderId }: { folderId: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const environmentId = useApp((s) => s.environmentId);
  const folderName = useApp((s) => s.folders.find((f) => f.id === folderId)?.name ?? "");
  const [type, setType] = useState<"constant" | "ramp" | "spike">("constant");
  const [vus, setVus] = useState("10");
  const [duration, setDuration] = useState("30s");
  const [stages, setStages] = useState("10s:10\n20s:10\n10s:0");
  const [spikeVus, setSpikeVus] = useState("50");
  const [spikeAt, setSpikeAt] = useState("10s");
  const [spikeFor, setSpikeFor] = useState("5s");
  const [think, setThink] = useState("0");
  const [thresholds, setThresholds] = useState("p95<500\nerrorRate<0.01");
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [live, setLive] = useState<{ vus: number; snapshot: LoadSnapshot } | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [past, setPast] = useState<PastRun[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  const loadPast = useCallback(() => {
    fetch(`/api/load-runs?workspaceId=${workspaceId}&folderId=${folderId}`)
      .then((r) => json<PastRun[]>(r))
      .then(setPast)
      .catch(() => undefined);
  }, [workspaceId, folderId]);
  useEffect(() => {
    loadPast();
  }, [loadPast]);
  useEffect(() => () => abort.current?.abort(), []);

  const buildProfile = (): LoadProfile => {
    const dur = (text: string, what: string) => {
      const n = parseDurationSec(text);
      if (n === null) throw new Error(`${what}: use a duration like 30s or 5m`);
      return n;
    };
    const n = (text: string, what: string) => {
      if (!/^\d+$/.test(text.trim())) throw new Error(`${what} must be a whole number`);
      return Number(text);
    };
    const raw =
      type === "constant"
        ? { type, vus: n(vus, "Virtual users"), durationSec: dur(duration, "Duration") }
        : type === "ramp"
          ? {
              type,
              startVus: 0,
              stages: stages
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .map((line) => {
                  const [d, t] = line.split(":");
                  return {
                    durationSec: dur(d ?? "", `Stage "${line}"`),
                    target: n(t ?? "", `Stage "${line}" target`),
                  };
                }),
            }
          : {
              type,
              baseVus: n(vus, "Base virtual users"),
              spikeVus: n(spikeVus, "Spike virtual users"),
              durationSec: dur(duration, "Duration"),
              spikeAtSec: dur(spikeAt, "Spike start"),
              spikeForSec: dur(spikeFor, "Spike length"),
            };
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid profile");
    return parsed.data;
  };

  const start = async () => {
    setError("");
    let profile: LoadProfile;
    let parsedThresholds: Threshold[];
    try {
      profile = buildProfile();
      parsedThresholds = thresholds
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseThreshold);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setLive(null);
    setDoc(null);
    setComparison(null);
    try {
      const res = await fetch("/api/load-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          workspaceId,
          folderId,
          environmentId,
          profile,
          thresholds: parsedThresholds,
          thinkMs: Number(think) || 0,
        }),
      });
      if (!res.ok || !res.body)
        throw new Error(
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
            `Request failed (${res.status})`,
        );
      let id = "";
      for await (const event of readNdjson(res.body)) {
        const e = event as {
          type: string;
          runId?: string;
          vus?: number;
          snapshot?: LoadSnapshot;
          error?: string;
        };
        if (e.runId) {
          id = e.runId;
          setRunId(e.runId);
        }
        if (e.type === "progress" && e.snapshot) setLive({ vus: e.vus ?? 0, snapshot: e.snapshot });
        if (e.type === "error") throw new Error(e.error);
      }
      if (id) {
        setDoc(await json<Doc>(await fetch(`/api/load-runs/${id}`)));
        setLive(null);
      }
      loadPast();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      setRunId(null);
    }
  };

  const stop = async () => {
    if (runId) await fetch(`/api/load-runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined);
    else abort.current?.abort();
  };

  const open = async (id: string) => {
    try {
      setDoc(await json<Doc>(await fetch(`/api/load-runs/${id}`)));
      setLive(null);
      setComparison(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const compare = async () => {
    const [base, head] = picked;
    try {
      setComparison(
        await json<Comparison>(
          await fetch(`/api/load-runs/compare?workspaceId=${workspaceId}&base=${base}&head=${head}`),
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const shown = live?.snapshot ?? doc?.result?.snapshot ?? null;
  const field = "h-7";

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4 text-xs">
      <div>
        <h2 className="text-lg font-medium">Load test {folderName}</h2>
        <p className="text-muted-foreground">
          Every virtual user loops over the selected requests with its own variables and cookies. Tests share
          the run queue, and the server&apos;s limits on users, duration and requests apply.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2" aria-label="Load profile">
        <label className="space-y-1">
          <span>Profile</span>
          <select
            className="h-7 w-full rounded-md border bg-transparent px-2"
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            disabled={running}
            aria-label="Profile type"
          >
            <option value="constant">Constant users</option>
            <option value="ramp">Ramp through stages</option>
            <option value="spike">Spike</option>
          </select>
        </label>
        {type !== "ramp" && (
          <label className="space-y-1">
            <span>{type === "spike" ? "Base virtual users" : "Virtual users"}</span>
            <Input
              className={field}
              value={vus}
              onChange={(e) => setVus(e.target.value)}
              disabled={running}
              aria-label="Virtual users"
            />
          </label>
        )}
        {type !== "ramp" && (
          <label className="space-y-1">
            <span>Duration</span>
            <Input
              className={field}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              disabled={running}
              aria-label="Duration"
            />
          </label>
        )}
        {type === "spike" && (
          <>
            <label className="space-y-1">
              <span>Spike virtual users</span>
              <Input
                className={field}
                value={spikeVus}
                onChange={(e) => setSpikeVus(e.target.value)}
                disabled={running}
                aria-label="Spike virtual users"
              />
            </label>
            <label className="space-y-1">
              <span>Spike starts at</span>
              <Input
                className={field}
                value={spikeAt}
                onChange={(e) => setSpikeAt(e.target.value)}
                disabled={running}
                aria-label="Spike starts at"
              />
            </label>
            <label className="space-y-1">
              <span>Spike lasts</span>
              <Input
                className={field}
                value={spikeFor}
                onChange={(e) => setSpikeFor(e.target.value)}
                disabled={running}
                aria-label="Spike lasts"
              />
            </label>
          </>
        )}
        {type === "ramp" && (
          <label className="space-y-1 sm:col-span-2">
            <span>Stages, one per line as duration:users (users ramp linearly to each target)</span>
            <Textarea
              className="font-mono"
              rows={3}
              value={stages}
              onChange={(e) => setStages(e.target.value)}
              disabled={running}
              aria-label="Stages"
            />
          </label>
        )}
        <label className="space-y-1">
          <span>Think time between requests (ms)</span>
          <Input
            className={field}
            value={think}
            onChange={(e) => setThink(e.target.value)}
            disabled={running}
            aria-label="Think time"
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span>Thresholds, one per line (p95&lt;500, errorRate&lt;0.01, rps&gt;=20@Request name)</span>
          <Textarea
            className="font-mono"
            rows={3}
            value={thresholds}
            onChange={(e) => setThresholds(e.target.value)}
            disabled={running}
            aria-label="Thresholds"
          />
        </label>
      </section>

      <div className="flex items-center gap-2">
        {running ? (
          <Button size="sm" variant="destructive" onClick={() => void stop()}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => void start()}>
            <Play className="size-3.5" /> Start load test
          </Button>
        )}
        {running && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {live ? `${Math.round(live.snapshot.elapsedSec)} s · ${live.vus} users` : "Waiting to start…"}
          </span>
        )}
      </div>
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}

      {shown && (
        <section className="space-y-3" aria-label="Load test results">
          {doc && !live && (
            <p>
              <strong>{doc.status}</strong> · {describeProfile(doc.profile)} · {formatDateTime(doc.startedAt)}
              {doc.result?.stoppedBy === "cancelled" && " · stopped early"}
              {doc.result?.stoppedBy === "maxRequests" && " · stopped at the request ceiling"}
              {doc.error && ` · ${doc.error}`}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Requests" value={String(shown.requests)} />
            <Stat label="Throughput" value={`${shown.rps}/s`} />
            <Stat
              label="Error rate"
              value={pct(shown.errorRate)}
              tone={shown.errorRate > 0 ? "bad" : undefined}
            />
            <Stat label="Peak users" value={String(shown.peakVus)} />
            <Stat label="p50" value={ms(shown.latency.p50)} />
            <Stat label="p90" value={ms(shown.latency.p90)} />
            <Stat label="p95" value={ms(shown.latency.p95)} />
            <Stat label="p99" value={ms(shown.latency.p99)} />
          </div>
          <LoadChart series={shown.series} />
          {doc?.result && !live && (
            <>
              {doc.result.thresholds.length > 0 && (
                <ul aria-label="Thresholds" className="space-y-0.5">
                  {doc.result.thresholds.map((t, i) => (
                    <li
                      key={i}
                      className={t.passed ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
                    >
                      {t.passed ? "Passed" : "Failed"} · {t.label}: {t.actual ?? "no data"}
                    </li>
                  ))}
                </ul>
              )}
              {doc.result.warnings.map((w) => (
                <p key={w} className="text-muted-foreground">
                  {w}
                </p>
              ))}
              <table className="w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2">Request</th>
                    <th className="pr-2">Requests</th>
                    <th className="pr-2">p50</th>
                    <th className="pr-2">p95</th>
                    <th className="pr-2">p99</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.result.snapshot.byRequest.map((r) => (
                    <tr key={r.name} className="border-t">
                      <td className="py-1 pr-2">{r.name}</td>
                      <td className="pr-2">{r.requests}</td>
                      <td className="pr-2">{ms(r.latency.p50)}</td>
                      <td className="pr-2">{ms(r.latency.p95)}</td>
                      <td className="pr-2">{ms(r.latency.p99)}</td>
                      <td>{pct(r.errorRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-2">
                {(["json", "csv", "junit"] as const).map((f) => (
                  <a
                    key={f}
                    className="rounded border px-2 py-1 hover:bg-accent"
                    href={`/api/load-runs/${doc.id}/export?format=${f}`}
                    download
                  >
                    Export {f.toUpperCase()}
                  </a>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <section className="space-y-1" aria-label="Past load tests">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Past tests</h3>
          <Button size="sm" variant="outline" disabled={picked.length !== 2} onClick={() => void compare()}>
            Compare selected
          </Button>
        </div>
        {past.length === 0 && <p className="text-muted-foreground">No load tests yet.</p>}
        <ul className="divide-y rounded border">
          {past.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-2 py-1">
              <input
                type="checkbox"
                aria-label={`Select test from ${formatDateTime(p.startedAt)}`}
                checked={picked.includes(p.id)}
                onChange={(e) =>
                  setPicked((cur) =>
                    e.target.checked ? [...cur, p.id].slice(-2) : cur.filter((x) => x !== p.id),
                  )
                }
              />
              <button className="min-w-0 flex-1 text-left hover:underline" onClick={() => void open(p.id)}>
                {formatDateTime(p.startedAt)} · {describeProfile(p.profile)} · <strong>{p.status}</strong>
                {p.summary &&
                  ` · ${p.summary.rps}/s · p95 ${ms(p.summary.p95)} · errors ${pct(p.summary.errorRate)}`}
              </button>
            </li>
          ))}
        </ul>
        {comparison && (
          <table className="mt-2 w-full text-left" aria-label="Comparison">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Metric</th>
                <th className="pr-2">Earlier</th>
                <th className="pr-2">Later</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(comparison.metrics).map(([name, c]) => (
                <tr key={name} className="border-t">
                  <td className="py-1 pr-2">{name}</td>
                  <td className="pr-2">{c.before}</td>
                  <td className="pr-2">{c.after}</td>
                  <td>{c.percent === null ? c.delta : `${c.percent > 0 ? "+" : ""}${c.percent}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
