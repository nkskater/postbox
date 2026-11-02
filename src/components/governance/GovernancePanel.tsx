"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_GOVERNANCE,
  governanceConfig,
  governanceOverrides,
  governanceExclusion,
  type GovernanceReport,
} from "@/core/governance/model";
import { z } from "zod";
import type {
  getRuleSet,
  listRuleSets,
  getSpecificationGovernance,
  listGovernanceReports,
} from "@/server/governance";
import type { listSpecifications } from "@/server/specifications";
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
export function GovernanceReportView({
  report,
  onFile,
}: {
  report: GovernanceReport;
  onFile?: (file: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  return (
    <section aria-label="Governance report" className="border rounded p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">
          {report.complete ? "Governance results" : "Governance evaluation incomplete"}
        </h3>
        <Button size="sm" variant="outline" onClick={() => download("governance-report.json", report)}>
          Export governance report
        </Button>
        <label className="text-xs">
          Diagnostic severity{" "}
          <select
            aria-label="Governance diagnostic severity"
            className="border rounded p-1 bg-background"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {["all", "error", "warning", "info"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-sm">
        {report.summary.errors} errors · {report.summary.warnings} warnings · {report.summary.info} info ·{" "}
        {report.summary.evaluated} evaluated · {report.summary.excluded} excluded · {report.summary.disabled}{" "}
        disabled · {report.summary.notApplicable} not applicable
      </p>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        Source {report.sourceHash}
        <br />
        Policy {report.rulesHash}
      </p>
      <ul className="space-y-2 max-h-[460px] overflow-auto text-xs">
        {report.diagnostics
          .filter((d) => filter === "all" || filter === d.severity)
          .map((d, i) => (
            <li key={i} className="border rounded p-2 [overflow-wrap:anywhere]">
              <strong>
                {d.severity} · {d.ruleId}
              </strong>
              <p>{d.message}</p>
              {onFile ? (
                <button className="underline" onClick={() => onFile(d.file)}>
                  {d.file}:{d.line}:{d.column}
                </button>
              ) : (
                <span>
                  {d.file}:{d.line}:{d.column}
                </span>
              )}
              <span> · {d.path || "/"}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
export function GovernancePanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <RuleSetEditor key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function RuleSetEditor({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<ReturnType<typeof listRuleSets>>([]),
    [specifications, setSpecifications] = useState<ReturnType<typeof listSpecifications>>([]),
    [doc, setDoc] = useState<ReturnType<typeof getRuleSet> | null>(null),
    [text, setText] = useState(JSON.stringify(DEFAULT_GOVERNANCE, null, 2)),
    [savedText, setSavedText] = useState(JSON.stringify(DEFAULT_GOVERNANCE, null, 2)),
    [label, setLabel] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [report, setReport] = useState<GovernanceReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const dirty = text !== savedText;
  const refresh = () => api.governance.list(workspaceId).then(setItems);
  useEffect(() => {
    let live = true;
    Promise.all([api.governance.list(workspaceId), api.specifications.list(workspaceId)])
      .then(([rules, specs]) => {
        if (live) {
          setItems(rules);
          setSpecifications(specs);
          setSourceId(specs[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  let parsed: ReturnType<typeof governanceConfig.safeParse> | undefined,
    parseError = "";
  try {
    parsed = governanceConfig.safeParse(JSON.parse(text));
    if (!parsed.success)
      parseError = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
  } catch {
    parseError = "Enter valid JSON for the rule set.";
  }
  function load(value: ReturnType<typeof getRuleSet>) {
    setDoc(value);
    const next = JSON.stringify(value.config, null, 2);
    setText(next);
    setSavedText(next);
    setLabel("");
    setReport(null);
  }
  const leave = () => !dirty || window.confirm("Discard unsaved governance rule changes?");
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
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <header className="flex flex-wrap gap-3 items-center">
        <h1 className="font-semibold text-lg">API governance</h1>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (!leave()) return;
            setDoc(null);
            const next = JSON.stringify(DEFAULT_GOVERNANCE, null, 2);
            setText(next);
            setSavedText(next);
            setLabel("");
            setReport(null);
            setError("");
            setMessage("");
          }}
        >
          New rule set
        </Button>
        <span className="text-xs text-muted-foreground">
          Versioned style and security checks · shared with the CLI
        </span>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Saved governance rule sets" className="space-y-2">
          {items.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              className={`block w-full rounded border p-3 text-left text-sm [overflow-wrap:anywhere] ${doc?.id === item.id ? "bg-accent" : ""}`}
              onClick={() => {
                if (!leave()) return;
                void perform(async () => load(await api.governance.get(item.id)));
              }}
            >
              <strong>{item.name}</strong>
              <p className="text-xs text-muted-foreground">v{item.revision}</p>
            </button>
          ))}
          {!items.length && <p className="text-xs">No saved rule sets.</p>}
        </aside>
        <main className="min-w-0 space-y-4">
          <section className="border rounded p-3 space-y-3">
            <div className="flex flex-wrap gap-2 items-center">
              <Button
                size="sm"
                disabled={busy || !!parseError}
                onClick={() =>
                  void perform(async () => {
                    if (!parsed?.success) return;
                    const value = doc
                      ? await api.governance.save(doc.id, {
                          expectedRevision: doc.revision,
                          config: parsed.data,
                          label,
                        })
                      : await api.governance.create({ workspaceId, config: parsed.data, label });
                    load(value);
                    await refresh();
                    setMessage(`Saved rule version ${value.version}`);
                  })
                }
              >
                {doc ? "Save new rule version" : "Save rule set"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!parseError}
                onClick={() => parsed?.success && download("governance-rules.json", parsed.data)}
              >
                Export rule set
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => upload.current?.click()}>
                Import rule set
              </Button>
              {doc && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Delete this policy, all its bindings and saved reports?")) return;
                    void perform(async () => {
                      await api.governance.delete(doc.id);
                      setDoc(null);
                      setText(JSON.stringify(DEFAULT_GOVERNANCE, null, 2));
                      setSavedText(JSON.stringify(DEFAULT_GOVERNANCE, null, 2));
                      setReport(null);
                      await refresh();
                    });
                  }}
                >
                  Delete rule set
                </Button>
              )}
            </div>
            <input
              ref={upload}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Import governance rule set"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file || !leave()) return;
                void perform(async () => {
                  if (file.size > 128 * 1024) throw Error("Rule set exceeds 128 KiB");
                  const config = governanceConfig.parse(JSON.parse(await file.text()));
                  setText(JSON.stringify(config, null, 2));
                  setReport(null);
                });
              }}
            />
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                Version label
                <Input
                  aria-label="Governance version label"
                  value={label}
                  disabled={busy}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {doc && (
                <label className="text-xs">
                  Saved policy version
                  <select
                    aria-label="Saved governance rule version"
                    className="block rounded border p-2 bg-background"
                    disabled={busy}
                    value={doc.version}
                    onChange={(e) => {
                      if (!leave()) return;
                      void perform(async () =>
                        load(await api.governance.get(doc.id, Number(e.target.value))),
                      );
                    }}
                  >
                    {doc.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                        {v.label ? " · " + v.label : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {dirty ? "Unsaved policy changes. " : ""}
              {doc && doc.version !== doc.revision
                ? `Viewing v${doc.version}; saving creates v${doc.revision + 1}. `
                : ""}
              Edit rules, severity overrides and justified exclusions as JSON. Rules are declarative and never
              execute scripts.
            </p>
            {parseError ? (
              <p role="alert" className="text-xs text-destructive">
                {parseError}
              </p>
            ) : (
              <p className="text-xs">
                Policy is valid · {parsed?.success ? parsed.data.rules.length : 0} rules
              </p>
            )}
            <div className="h-[440px] border rounded overflow-hidden" aria-label="Governance rule editor">
              <CodeEditor
                value={text}
                onChange={(value) => {
                  setText(value);
                  setReport(null);
                }}
                language="json"
                variables={false}
                readOnly={busy}
              />
            </div>
            {parsed?.success && (
              <div className="space-y-1 max-h-52 overflow-auto">
                {parsed.data.rules.map((rule, index) => (
                  <label
                    key={rule.id}
                    className="flex flex-wrap justify-between gap-2 border rounded p-2 text-xs"
                  >
                    <span>
                      {rule.id} · {rule.message}
                    </span>
                    <select
                      aria-label={`Severity ${rule.id}`}
                      className="border rounded bg-background"
                      disabled={busy}
                      value={
                        parsed!.success ? (parsed.data.overrides[rule.id] ?? rule.severity) : rule.severity
                      }
                      onChange={(e) => {
                        if (!parsed?.success) return;
                        const config = {
                          ...parsed.data,
                          overrides: {
                            ...parsed.data.overrides,
                            [parsed.data.rules[index].id]: e.target.value,
                          },
                        };
                        setText(JSON.stringify(config, null, 2));
                        setReport(null);
                      }}
                    >
                      {["error", "warning", "info", "off"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </section>
          <section className="border rounded p-3 space-y-3">
            <h2 className="font-medium">Try draft policy</h2>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Governance test specification"
                className="rounded border p-2 bg-background text-sm max-w-full"
                value={sourceId}
                disabled={busy}
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">Select saved source</option>
                {specifications.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.format}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !sourceId || !!parseError}
                onClick={() =>
                  void perform(async () => {
                    if (!parsed?.success) return;
                    const spec = await api.specifications.get(sourceId);
                    setReport(
                      await api.governance.lint({
                        workspaceId,
                        source: { format: spec.format, entrypoint: spec.entrypoint, files: spec.files },
                        config: parsed.data,
                      }),
                    );
                  })
                }
              >
                Preview draft rules
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This evaluates the latest saved specification and unsaved policy without retaining a report.
            </p>
          </section>
          {report && <GovernanceReportView report={report} />}
        </main>
      </div>
    </div>
  );
}
export function SpecificationGovernancePanel({
  specificationId,
  version,
  workspaceId,
  disabled = false,
  onBusyChange,
  onFile,
}: {
  specificationId: string;
  version: number;
  workspaceId: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onFile?: (file: string) => void;
}) {
  const [state, setState] = useState<ReturnType<typeof getSpecificationGovernance> | null>(null),
    [policies, setPolicies] = useState<ReturnType<typeof listRuleSets>>([]),
    [history, setHistory] = useState<ReturnType<typeof listGovernanceReports>>([]),
    [ruleSetId, setRuleSetId] = useState(""),
    [pin, setPin] = useState(""),
    [overrides, setOverrides] = useState("{}"),
    [exclusions, setExclusions] = useState("[]"),
    [assignmentDirty, setAssignmentDirty] = useState(false),
    [report, setReport] = useState<GovernanceReport | null>(null),
    [reportId, setReportId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    const [value, rules, reports] = await Promise.all([
      api.governance.binding(specificationId),
      api.governance.list(workspaceId),
      api.governance.reports(specificationId),
    ]);
    setState(value);
    setPolicies(rules);
    setHistory(reports);
    setRuleSetId(value.binding?.ruleSetId ?? rules[0]?.id ?? "");
    setPin(value.binding?.ruleVersion ? String(value.binding.ruleVersion) : "");
    setOverrides(JSON.stringify(value.binding?.overrides ?? {}, null, 2));
    setExclusions(JSON.stringify(value.binding?.exclusions ?? [], null, 2));
    setAssignmentDirty(false);
    return value;
  }
  useEffect(() => {
    let live = true;
    Promise.all([
      api.governance.binding(specificationId),
      api.governance.list(workspaceId),
      api.governance.reports(specificationId),
    ])
      .then(([value, rules, reports]) => {
        if (!live) return;
        setState(value);
        setPolicies(rules);
        setHistory(reports);
        setRuleSetId(value.binding?.ruleSetId ?? rules[0]?.id ?? "");
        setPin(value.binding?.ruleVersion ? String(value.binding.ruleVersion) : "");
        setOverrides(JSON.stringify(value.binding?.overrides ?? {}, null, 2));
        setExclusions(JSON.stringify(value.binding?.exclusions ?? [], null, 2));
        setAssignmentDirty(false);
        setReport(value.latest?.report ?? null);
        setReportId(value.latest?.id ?? "");
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [specificationId, version, workspaceId]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  const locked = disabled || busy;
  return (
    <section className="border rounded p-3 space-y-3">
      <h2 className="font-medium">Specification governance</h2>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {state && "configurationError" in state && state.configurationError && (
        <p role="alert" className="text-sm text-destructive">
          {state.configurationError}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">
          Rule set
          <select
            aria-label="Specification governance rule set"
            className="block w-full rounded border p-2 bg-background"
            disabled={locked}
            value={ruleSetId}
            onChange={(e) => {
              setRuleSetId(e.target.value);
              setPin("");
              setAssignmentDirty(true);
            }}
          >
            <option value="">Select policy</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · v{p.revision}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Pin version (blank follows latest)
          <Input
            aria-label="Pinned governance rule version"
            type="number"
            min="1"
            value={pin}
            disabled={locked}
            onChange={(e) => {
              setPin(e.target.value);
              setAssignmentDirty(true);
            }}
          />
        </label>
        <label className="text-xs">
          Severity overrides (JSON)
          <textarea
            aria-label="Governance severity overrides"
            className="block border rounded p-2 bg-background w-full font-mono"
            rows={3}
            value={overrides}
            disabled={locked}
            onChange={(e) => {
              setOverrides(e.target.value);
              setAssignmentDirty(true);
            }}
          />
        </label>
        <label className="text-xs">
          Exclusions with reasons (JSON)
          <textarea
            aria-label="Governance exclusions"
            className="block border rounded p-2 bg-background w-full font-mono"
            rows={3}
            value={exclusions}
            disabled={locked}
            onChange={(e) => {
              setExclusions(e.target.value);
              setAssignmentDirty(true);
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={locked || !ruleSetId}
          onClick={() =>
            void perform(async () => {
              const parsedOverrides = governanceOverrides.parse(JSON.parse(overrides)),
                parsedExclusions = z.array(governanceExclusion).parse(JSON.parse(exclusions));
              await api.governance.bind(specificationId, {
                ruleSetId,
                ruleVersion: pin ? Number(pin) : null,
                overrides: parsedOverrides,
                exclusions: parsedExclusions,
                expectedRevision: state?.binding?.revision ?? 0,
              });
              await refresh();
              setReport(null);
              setReportId("");
            })
          }
        >
          Save governance assignment
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || assignmentDirty || !state?.config}
          onClick={() =>
            void perform(async () => {
              setReport(await api.governance.preview(specificationId, version));
              setReportId("");
            })
          }
        >
          Preview governance
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || assignmentDirty || !state?.config}
          onClick={() =>
            void perform(async () => {
              const value = await api.governance.run(specificationId, version);
              setReport(value.report);
              setReportId(value.id);
              await refresh();
            })
          }
        >
          Run and save report
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || !state?.config}
          onClick={() => state?.config && download("effective-governance-rules.json", state.config)}
        >
          Export effective policy
        </Button>
        {state?.binding && (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void perform(async () => {
                await api.governance.unbind(specificationId);
                await refresh();
                setReport(null);
              })
            }
          >
            Remove governance assignment
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {assignmentDirty ? "Unsaved assignment changes. " : ""}Checks use saved source v{version}.{" "}
        {state?.binding
          ? state.stale
            ? "Latest retained report is stale or unavailable."
            : "Latest retained report matches the current source and policy."
          : "Choose a policy or create one in the Governance screen."}
      </p>
      {history.length > 0 && (
        <label className="text-xs block">
          Saved reports
          <select
            aria-label="Saved governance report"
            className="border rounded p-2 bg-background ml-2"
            value={reportId}
            disabled={locked}
            onChange={(e) => {
              const id = e.target.value;
              setReportId(id);
              if (id)
                void perform(async () =>
                  setReport((await api.governance.report(specificationId, id)).report),
                );
            }}
          >
            <option value="">Unsaved preview</option>
            {history.map((r) => (
              <option key={r.id} value={r.id}>
                Source v{r.specVersion} · policy v{r.ruleVersion} · {r.summary.errors} errors ·{" "}
                {new Date(r.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}
      {report && <GovernanceReportView report={report} onFile={onFile} />}
    </section>
  );
}
