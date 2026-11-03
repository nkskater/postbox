"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { DEFAULT_SCORECARD, scorecardConfig } from "@/core/scorecards/model";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type * as service from "@/server/scorecards";
type Card = ReturnType<typeof service.getScorecard>;
type Sources = ReturnType<typeof service.scorecardSources>;
type Report = ReturnType<typeof service.previewScorecard>;
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const number = (value: number | null) =>
  value === null ? "Unavailable" : String(Math.round(value * 100) / 100);
export function QualityReportView({ report }: { report: Report }) {
  return (
    <section aria-label="Quality report" className="border rounded p-3 space-y-3">
      <div className="flex flex-wrap gap-3 items-center">
        <h2 className="font-semibold">Quality results</h2>
        <Button size="sm" variant="outline" onClick={() => download("quality-report.json", report)}>
          Export quality report
        </Button>
      </div>
      <p className="text-sm">
        {report.summary.status} · Score {number(report.summary.score)} / 100 · Coverage{" "}
        {report.summary.coverage}% · {report.summary.services} service/environment slices
      </p>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        Snapshot {new Date(report.at).toLocaleString()} · Policy v{report.version} · {report.policyHash}
      </p>
      <p className="text-xs text-muted-foreground">
        Unavailable sources never pass a check. Scores with coverage below the configured minimum have unknown
        quality. Snapshots describe their evaluation time.
      </p>
      {!report.services.length && (
        <p className="text-sm">No visible service assignments match these filters.</p>
      )}
      <div className="space-y-4 max-h-[700px] overflow-auto">
        {report.services.map((item) => (
          <article key={item.bindingId} className="border rounded p-3 space-y-2">
            <h3 className="font-medium [overflow-wrap:anywhere]">
              {item.title} · {item.environmentName}
            </h3>
            <p className="text-sm">
              {item.evaluation.status} · Score {number(item.evaluation.score)} · Coverage{" "}
              {item.evaluation.coverage}% · Catalog v{item.catalogVersion}
            </p>
            <p className="text-xs">
              Owners: {item.owners.join(", ") || "None"} · Tags: {item.tags.join(", ") || "None"}
            </p>
            {item.evaluation.categories.map((category) => (
              <div key={category.id} className="space-y-2">
                <h4 className="text-sm font-medium">
                  {category.name} · {number(category.score)} · {category.coverage}% coverage
                </h4>
                <div className="overflow-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr>
                        <th className="p-2">Metric</th>
                        <th className="p-2">Value</th>
                        <th className="p-2">Score</th>
                        <th className="p-2">Source and freshness</th>
                      </tr>
                    </thead>
                    <tbody>
                      {category.metrics.map((metric) => (
                        <tr key={metric.id} className="border-t">
                          <td className="p-2">
                            {metric.name}
                            <p className="text-muted-foreground">
                              Weight {metric.weight}; good {metric.good}, bad {metric.bad}
                            </p>
                          </td>
                          <td className="p-2">{number(metric.value)}</td>
                          <td className="p-2">{number(metric.score)}</td>
                          <td className="p-2 [overflow-wrap:anywhere]">
                            {metric.state}: {metric.reason}
                            <p>
                              {metric.observedAt === null
                                ? "No observation"
                                : new Date(metric.observedAt).toLocaleString()}{" "}
                              · Maximum age {metric.maxAgeHours}h
                            </p>
                            {metric.source && (
                              <p className="text-muted-foreground">
                                {metric.source.kind} · {metric.source.id} · {metric.source.version}
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
export function ScorecardsPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <WorkspaceScorecards key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p>Select a workspace.</p>
  );
}
function WorkspaceScorecards({ workspaceId }: { workspaceId: string }) {
  const [cards, setCards] = useState<ReturnType<typeof service.listScorecards>>([]),
    [doc, setDoc] = useState<Card | null>(null),
    [sources, setSources] = useState<Sources | null>(null),
    [text, setText] = useState(JSON.stringify(DEFAULT_SCORECARD, null, 2)),
    [savedText, setSavedText] = useState(JSON.stringify(DEFAULT_SCORECARD, null, 2)),
    [label, setLabel] = useState(""),
    [entryId, setEntryId] = useState(""),
    [environmentId, setEnvironmentId] = useState(""),
    [specificationId, setSpecificationId] = useState(""),
    [monitorId, setMonitorId] = useState(""),
    [tag, setTag] = useState(""),
    [owner, setOwner] = useState(""),
    [filterEnv, setFilterEnv] = useState("*"),
    [history, setHistory] = useState<ReturnType<typeof service.listQualityReports>>([]),
    [report, setReport] = useState<Report | null>(null),
    [reportId, setReportId] = useState(""),
    [beforeId, setBeforeId] = useState(""),
    [afterId, setAfterId] = useState(""),
    [comparison, setComparison] = useState<ReturnType<typeof service.compareQualityReports> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const importRef = useRef<HTMLInputElement>(null),
    dirty = text !== savedText;
  const filters = useMemo<Record<string, string>>(
    () => ({
      ...(tag ? { tag } : {}),
      ...(owner ? { owner } : {}),
      ...(filterEnv !== "*" ? { environmentId: filterEnv } : {}),
    }),
    [tag, owner, filterEnv],
  );
  const cardId = doc?.id;

  let parsed: ReturnType<typeof scorecardConfig.safeParse> | undefined,
    parseError = "";
  try {
    parsed = scorecardConfig.safeParse(JSON.parse(text));
    if (!parsed.success)
      parseError = parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
  } catch {
    parseError = "Enter valid scorecard JSON.";
  }
  useEffect(() => {
    let live = true;
    api.scorecards
      .list(workspaceId)
      .then((v) => {
        if (live) setCards(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  useEffect(() => {
    let live = true;
    if (cardId)
      api.scorecards
        .reports(cardId, filters)
        .then((v) => {
          if (live) setHistory(v);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [cardId, filters]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const leave = () => !dirty || window.confirm("Discard unsaved scorecard changes?");
  async function load(card: Card) {
    setDoc(card);
    const next = JSON.stringify(card.config, null, 2);
    setText(next);
    setSavedText(next);
    setLabel("");
    setEntryId("");
    setEnvironmentId("");
    setSpecificationId("");
    setMonitorId("");
    setSources(await api.scorecards.sources(card.id));
    setHistory(await api.scorecards.reports(card.id, filters));
    setReport(null);
    setComparison(null);
    setReportId("");
    setBeforeId("");
    setAfterId("");
  }
  async function refreshSources() {
    if (doc) setSources(await api.scorecards.sources(doc.id));
  }
  function selectBinding(id: string) {
    const b = sources?.bindings.find((v) => v.id === id);
    setEntryId(b?.entryId ?? "");
    setEnvironmentId(b?.environmentId ?? "");
    setSpecificationId(b?.specificationId ?? "");
    setMonitorId(b?.monitorId ?? "");
  }
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap gap-3 items-center">
        <h1 className="font-semibold text-lg">API quality scorecards</h1>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (!leave()) return;
            setDoc(null);
            const next = JSON.stringify(DEFAULT_SCORECARD, null, 2);
            setText(next);
            setSavedText(next);
            setSources(null);
            setHistory([]);
            setReport(null);
            setComparison(null);
            setMessage("");
            setError("");
          }}
        >
          New scorecard
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        Combine existing catalog metadata, monitor measurements and saved specification governance into
        weighted quality scores. These checks do not run requests or governance evaluations.
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Saved quality scorecards" className="space-y-2">
          {cards.map((c) => (
            <button
              key={c.id}
              disabled={busy}
              className={`block w-full border rounded p-3 text-left text-sm [overflow-wrap:anywhere] ${doc?.id === c.id ? "bg-accent" : ""}`}
              onClick={() => {
                if (leave()) void perform(async () => load(await api.scorecards.get(c.id)));
              }}
            >
              <strong>{c.name}</strong>
              <p>v{c.revision}</p>
            </button>
          ))}
          {!cards.length && <p className="text-xs">No saved scorecards.</p>}
        </aside>
        <div className="min-w-0 space-y-4">
          <section className="border rounded p-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !!parseError}
                onClick={() =>
                  void perform(async () => {
                    if (!parsed?.success) return;
                    const value = doc
                      ? await api.scorecards.save(doc.id, {
                          expectedRevision: doc.revision,
                          config: parsed.data,
                          label,
                        })
                      : await api.scorecards.create({ workspaceId, config: parsed.data, label });
                    await load(value);
                    setCards(await api.scorecards.list(workspaceId));
                    setMessage(`Saved scorecard version ${value.version}`);
                  })
                }
              >
                {doc ? "Save scorecard version" : "Save scorecard"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!parseError}
                onClick={() => parsed?.success && download("scorecard-policy.json", parsed.data)}
              >
                Export scorecard policy
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => importRef.current?.click()}>
                Import scorecard policy
              </Button>
              {doc && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Delete this scorecard, assignments and reports?"))
                      void perform(async () => {
                        await api.scorecards.delete(doc.id);
                        setDoc(null);
                        setSources(null);
                        setReport(null);
                        setComparison(null);
                        setHistory([]);
                        setCards(await api.scorecards.list(workspaceId));
                        const next = JSON.stringify(DEFAULT_SCORECARD, null, 2);
                        setText(next);
                        setSavedText(next);
                      });
                  }}
                >
                  Delete scorecard
                </Button>
              )}
            </div>
            <input
              ref={importRef}
              type="file"
              className="hidden"
              accept=".json,application/json"
              aria-label="Import scorecard policy"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file || !leave()) return;
                void perform(async () => {
                  if (file.size > 64 * 1024) throw Error("Policy exceeds 64 KiB");
                  setText(JSON.stringify(scorecardConfig.parse(JSON.parse(await file.text())), null, 2));
                  setReport(null);
                });
              }}
            />
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                Version label
                <Input
                  aria-label="Scorecard version label"
                  disabled={busy}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {doc && (
                <label className="text-xs">
                  Saved policy version
                  <select
                    aria-label="Saved scorecard version"
                    disabled={busy}
                    value={doc.version}
                    className="block border rounded p-2 bg-background"
                    onChange={(e) => {
                      if (leave())
                        void perform(async () =>
                          load(await api.scorecards.get(doc.id, Number(e.target.value))),
                        );
                    }}
                  >
                    {doc.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                        {v.label ? ` · ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Edit category/metric weights, good and bad targets, freshness limits and quality thresholds as
              JSON. {dirty ? "Unsaved changes. " : ""}
              {doc && doc.version !== doc.revision
                ? `Viewing v${doc.version}; saving appends v${doc.revision + 1}.`
                : ""}
            </p>
            {parseError ? (
              <p role="alert" className="text-xs text-destructive">
                {parseError}
              </p>
            ) : (
              <p className="text-xs">
                Policy is valid · {parsed?.success ? parsed.data.categories.length : 0} categories
              </p>
            )}
            <div className="h-[360px] border rounded overflow-hidden" aria-label="Scorecard policy editor">
              <CodeEditor language="json" variables={false} readOnly={busy} value={text} onChange={setText} />
            </div>
          </section>
          {doc && sources && (
            <>
              <section className="border rounded p-3 space-y-3">
                <h2 className="font-medium">Service assignments</h2>
                <p className="text-xs text-muted-foreground">
                  Choose a published catalog collection and environment. Optional monitor and specification
                  sources stay in this workspace. A monitor must match the collection and environment.
                </p>
                <label className="text-xs block">
                  Edit assignment
                  <select
                    aria-label="Existing quality assignment"
                    className="border rounded bg-background p-2 ml-2"
                    disabled={busy}
                    defaultValue=""
                    onChange={(e) => selectBinding(e.target.value)}
                  >
                    <option value="">New assignment</option>
                    {sources.bindings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {sources.entries.find((e) => e.id === b.entryId)?.title} ·{" "}
                        {sources.environments.find((e) => e.id === b.environmentId)?.name ??
                          (b.environmentId ? "Deleted environment" : "No environment")}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs">
                    Catalog service
                    <select
                      aria-label="Quality catalog service"
                      disabled={busy}
                      className="block w-full border rounded p-2 bg-background"
                      value={entryId}
                      onChange={(e) => {
                        setEntryId(e.target.value);
                        setMonitorId("");
                      }}
                    >
                      <option value="">Select service</option>
                      {sources.entries.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    Environment
                    <select
                      aria-label="Quality service environment"
                      disabled={busy}
                      className="block w-full border rounded p-2 bg-background"
                      value={environmentId}
                      onChange={(e) => {
                        setEnvironmentId(e.target.value);
                        setMonitorId("");
                      }}
                    >
                      <option value="">No environment</option>
                      {sources.environments.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    Specification
                    <select
                      aria-label="Quality specification source"
                      disabled={busy}
                      className="block w-full border rounded p-2 bg-background"
                      value={specificationId}
                      onChange={(e) => setSpecificationId(e.target.value)}
                    >
                      <option value="">No specification</option>
                      {sources.specifications.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    Monitor
                    <select
                      aria-label="Quality monitor source"
                      disabled={busy}
                      className="block w-full border rounded p-2 bg-background"
                      value={monitorId}
                      onChange={(e) => setMonitorId(e.target.value)}
                    >
                      <option value="">No monitor</option>
                      {sources.monitors
                        .filter(
                          (m) =>
                            m.folderId === sources.entries.find((e) => e.id === entryId)?.folderId &&
                            (m.environmentId ?? "") === environmentId,
                        )
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !entryId}
                    onClick={() =>
                      void perform(async () => {
                        const previous = sources.bindings.find(
                          (b) => b.entryId === entryId && b.environmentId === environmentId,
                        );
                        await api.scorecards.bind(doc.id, {
                          entryId,
                          environmentId,
                          specificationId: specificationId || null,
                          monitorId: monitorId || null,
                          expectedRevision: previous?.revision ?? 0,
                        });
                        await refreshSources();
                        setMessage("Saved service assignment");
                        setReport(null);
                      })
                    }
                  >
                    Save quality assignment
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform(refreshSources)}
                  >
                    Refresh source choices
                  </Button>
                </div>
                <ul className="text-xs space-y-2">
                  {sources.bindings.map((b) => (
                    <li key={b.id} className="flex gap-3 items-center">
                      <span>
                        {sources.entries.find((e) => e.id === b.entryId)?.title} ·{" "}
                        {sources.environments.find((e) => e.id === b.environmentId)?.name ??
                          (b.environmentId ? "Deleted environment" : "No environment")}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api.scorecards.unbind(doc.id, b.id);
                            await refreshSources();
                            setReport(null);
                          })
                        }
                      >
                        Remove assignment
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="border rounded p-3 space-y-3">
                <h2 className="font-medium">Evaluate and compare</h2>
                <div className="flex flex-wrap gap-3">
                  <Input
                    aria-label="Quality filter tag"
                    className="max-w-48"
                    placeholder="Exact tag"
                    value={tag}
                    disabled={busy}
                    onChange={(e) => {
                      setTag(e.target.value);
                      setReport(null);
                      setReportId("");
                      setComparison(null);
                      setBeforeId("");
                      setAfterId("");
                    }}
                  />
                  <Input
                    aria-label="Quality filter owner"
                    className="max-w-48"
                    placeholder="Exact owner"
                    value={owner}
                    disabled={busy}
                    onChange={(e) => {
                      setOwner(e.target.value);
                      setReport(null);
                      setReportId("");
                      setComparison(null);
                      setBeforeId("");
                      setAfterId("");
                    }}
                  />
                  <select
                    aria-label="Quality filter environment"
                    className="border rounded p-2 bg-background"
                    value={filterEnv}
                    disabled={busy}
                    onChange={(e) => {
                      setFilterEnv(e.target.value);
                      setReport(null);
                      setReportId("");
                      setComparison(null);
                      setBeforeId("");
                      setAfterId("");
                    }}
                  >
                    <option value="*">All environments</option>
                    <option value="">No environment</option>
                    {sources.environments.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || dirty}
                    onClick={() =>
                      void perform(async () => {
                        setReport(await api.scorecards.preview(doc.id, { version: doc.version, filters }));
                        setReportId("");
                      })
                    }
                  >
                    Preview quality
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || dirty}
                    onClick={() =>
                      void perform(async () => {
                        const saved = await api.scorecards.run(doc.id, { version: doc.version, filters });
                        setReport(saved.report);
                        setReportId(saved.id);
                        setHistory(await api.scorecards.reports(doc.id, filters));
                        setMessage("Saved quality report");
                      })
                    }
                  >
                    Run and save quality report
                  </Button>
                </div>
                <label className="text-xs block">
                  Saved report
                  <select
                    aria-label="Saved quality report"
                    disabled={busy}
                    value={reportId}
                    className="border rounded bg-background p-2 ml-2"
                    onChange={(e) => {
                      const id = e.target.value;
                      setReportId(id);
                      if (id)
                        void perform(async () =>
                          setReport((await api.scorecards.report(doc.id, id, filters)).report),
                        );
                    }}
                  >
                    <option value="">Unsaved preview</option>
                    {history.map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.version} · {new Date(r.createdAt).toLocaleString()} · {r.summary.status} ·{" "}
                        {number(r.summary.score)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2 items-center">
                  <label className="text-xs">
                    Before
                    <select
                      aria-label="Quality comparison before"
                      disabled={busy}
                      value={beforeId}
                      className="block border rounded bg-background p-2"
                      onChange={(e) => setBeforeId(e.target.value)}
                    >
                      <option value="">Select report</option>
                      {history.map((r) => (
                        <option key={r.id} value={r.id}>
                          v{r.version} · {new Date(r.createdAt).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    After
                    <select
                      aria-label="Quality comparison after"
                      disabled={busy}
                      value={afterId}
                      className="block border rounded bg-background p-2"
                      onChange={(e) => setAfterId(e.target.value)}
                    >
                      <option value="">Select report</option>
                      {history.map((r) => (
                        <option key={r.id} value={r.id}>
                          v{r.version} · {new Date(r.createdAt).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !beforeId || !afterId}
                    onClick={() =>
                      void perform(async () =>
                        setComparison(await api.scorecards.compare(doc.id, { beforeId, afterId, filters })),
                      )
                    }
                  >
                    Compare quality reports
                  </Button>
                </div>
                {comparison && (
                  <div aria-label="Quality comparison" className="border rounded p-3 space-y-2">
                    <p className="text-sm">
                      {comparison.policyChanged
                        ? "Policy changed between these reports; metric comparisons flag changed definitions."
                        : "Same policy definition."}
                    </p>
                    {comparison.services.map((s) => (
                      <div key={s.entryId + ":" + s.environmentId} className="text-sm space-y-2">
                        <p>
                          {s.title} · {s.environmentName}:{" "}
                          {s.comparison
                            ? `score change ${number(s.comparison.scoreDelta)}; coverage change ${s.comparison.coverageDelta}%`
                            : "New service/environment slice"}
                        </p>
                        {s.comparison && (
                          <details className="text-xs">
                            <summary className="cursor-pointer">Metric changes</summary>
                            <ul className="space-y-1 p-2">
                              {s.comparison.metrics.map((m) => (
                                <li key={m.id}>
                                  {m.id}: {number(m.before)} → {number(m.after)} ·{" "}
                                  {m.comparable
                                    ? `change ${number(m.delta)}`
                                    : "Definition changed; scores are not comparable"}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    ))}
                    {comparison.removed.map((s) => (
                      <p key={s.entryId + ":" + s.environmentId} className="text-sm">
                        {s.title} · {s.environmentName}: removed from the later report
                      </p>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download("quality-comparison.json", comparison)}
                    >
                      Export quality comparison
                    </Button>
                  </div>
                )}
              </section>
            </>
          )}
          {report && <QualityReportView report={report} />}
        </div>
      </div>
    </div>
  );
}
