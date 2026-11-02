"use client";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/stores/app";
import { api } from "@/lib/api";
import { SpecificationGovernancePanel } from "@/components/governance/GovernancePanel";
import { SpecificationCollectionsPanel } from "./SpecificationSyncPanel";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SPEC_LIMITS,
  specificationSource,
  type SpecificationFormat,
  type SpecificationSource,
  type SpecificationAnalysis,
} from "@/core/specifications/model";
import type { getSpecification, listSpecifications } from "@/server/specifications";
const templates: Record<SpecificationFormat, { path: string; content: string }> = {
  openapi: {
    path: "openapi.yaml",
    content:
      'openapi: 3.0.3\ninfo:\n  title: New API\n  version: 1.0.0\npaths:\n  /health:\n    get:\n      summary: Health check\n      responses:\n        "200":\n          description: Healthy\n',
  },
  asyncapi: {
    path: "asyncapi.yaml",
    content:
      'asyncapi: 3.0.0\ninfo:\n  title: Events API\n  version: 1.0.0\nchannels:\n  events:\n    address: events\noperations:\n  receiveEvents:\n    action: receive\n    channel:\n      $ref: "#/channels/events"\n',
  },
  graphql: { path: "schema.graphql", content: '"API query root"\ntype Query {\n  health: String!\n}\n' },
  protobuf: {
    path: "service.proto",
    content:
      'syntax = "proto3";\npackage example;\nservice Health { rpc Check (Request) returns (Response); }\nmessage Request {}\nmessage Response { string status = 1; }\n',
  },
  smithy: {
    path: "model.smithy",
    content:
      '$version: "2"\nnamespace example\n\n@documentation("Health service")\nservice Health { version: "1.0", operations: [Check] }\noperation Check { input: CheckInput, output: CheckOutput }\nstructure CheckInput {}\nstructure CheckOutput { status: String }\n',
  },
};
const makeSource = (format: SpecificationFormat): SpecificationSource => ({
  format,
  entrypoint: templates[format].path,
  files: [{ ...templates[format] }],
});
function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SpecificationsPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <WorkspaceSpecifications key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function WorkspaceSpecifications({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<ReturnType<typeof listSpecifications>>([]),
    [doc, setDoc] = useState<ReturnType<typeof getSpecification> | null>(null),
    [source, setSource] = useState(() => makeSource("openapi")),
    [name, setName] = useState("New API"),
    [label, setLabel] = useState(""),
    [file, setFile] = useState("openapi.yaml"),
    [fileName, setFileName] = useState(""),
    [analysis, setAnalysis] = useState<SpecificationAnalysis | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [selectedSymbol, setSelectedSymbol] = useState("");
  const selection = useRef(0),
    fileInput = useRef<HTMLInputElement>(null),
    bundleInput = useRef<HTMLInputElement>(null);
  const refresh = () => api.specifications.list(workspaceId).then(setItems);
  useEffect(() => {
    let live = true;
    api.specifications
      .list(workspaceId)
      .then((v) => {
        if (live) setItems(v);
      })
      .catch((e) => {
        if (live) setError(String(e.message));
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const change = (next: SpecificationSource) => {
    setSource(next);
    setDirty(true);
    setAnalysis(null);
    setMessage("");
  };
  const load = (value: ReturnType<typeof getSpecification>) => {
    setDoc(value);
    setSource({ format: value.format, entrypoint: value.entrypoint, files: value.files });
    setName(value.name);
    setFile(value.entrypoint);
    setAnalysis(value.analysis);
    setLabel("");
    setDirty(false);
    setSelectedSymbol("");
  };
  const canLeave = () => !dirty || window.confirm("Discard unsaved specification changes?");
  async function select(id: string, version?: number) {
    if (!canLeave()) return;
    const ticket = ++selection.current;
    setBusy(true);
    setError("");
    try {
      const value = await api.specifications.get(id, version);
      if (ticket === selection.current) load(value);
    } catch (e) {
      if (ticket === selection.current) setError((e as Error).message);
    } finally {
      if (ticket === selection.current) setBusy(false);
    }
  }
  async function perform(fn: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    await perform(async () => {
      const value = doc
        ? await api.specifications.save(doc.specificationId, {
            expectedRevision: doc.revision,
            name,
            label,
            entrypoint: source.entrypoint,
            files: source.files,
          })
        : await api.specifications.create({ ...source, workspaceId, name, label });
      load(value);
      await refresh();
      setMessage(`Saved version ${value.version}`);
    });
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    await perform(async () => {
      const uploads = Array.from(list);
      if (uploads.length + source.files.length > SPEC_LIMITS.files)
        throw Error("At most 30 files per bundle");
      const additions = [];
      for (const upload of uploads) {
        if (upload.size > SPEC_LIMITS.bytes) throw Error("Files must be at most 1 MiB");
        additions.push({ path: upload.name, content: await upload.text() });
      }
      const merged = new Map(source.files.map((f) => [f.path, f]));
      for (const addition of additions) {
        if (merged.has(addition.path) && !window.confirm(`Replace ${addition.path} in the unsaved draft?`))
          continue;
        merged.set(addition.path, addition);
      }
      change({ ...source, files: [...merged.values()] });
    });
  }
  const selected = source.files.find((f) => f.path === file),
    oldVersion = !!doc && doc.version !== doc.revision;
  const activeSymbol = analysis?.symbols.find((s) => `${s.file}:${s.line}:${s.name}` === selectedSymbol);
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">API specifications</h1>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (!canLeave()) return;
            selection.current++;
            setDoc(null);
            setSource(makeSource("openapi"));
            setFile("openapi.yaml");
            setName("New API");
            setLabel("");
            setAnalysis(null);
            setDirty(false);
            setError("");
            setMessage("");
          }}
        >
          New specification
        </Button>
        <span className="text-xs text-muted-foreground">
          Versioned source, diagnostics, references and documentation
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
        <aside className="space-y-2" aria-label="Saved specifications">
          {items.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              onClick={() => void select(item.id)}
              className={`block w-full p-3 rounded border text-left text-sm [overflow-wrap:anywhere] ${doc?.specificationId === item.id ? "bg-accent" : ""}`}
            >
              <strong>{item.name}</strong>
              <div className="text-xs text-muted-foreground">
                {item.format} · v{item.revision}
              </div>
            </button>
          ))}
          {!items.length && <p className="text-sm text-muted-foreground">No saved specifications.</p>}
        </aside>
        <main className="min-w-0 space-y-4">
          <section className="rounded border p-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs">
                Specification name
                <Input
                  aria-label="Specification name"
                  value={name}
                  disabled={busy}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="text-xs">
                Format
                <select
                  aria-label="Specification format"
                  className="block w-full border rounded p-2 bg-background"
                  value={source.format}
                  disabled={busy || !!doc}
                  onChange={(e) => {
                    if (!canLeave()) return;
                    const next = makeSource(e.target.value as SpecificationFormat);
                    change(next);
                    setFile(next.entrypoint);
                  }}
                >
                  {Object.keys(templates).map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                Version label
                <Input
                  aria-label="Specification version label"
                  value={label}
                  disabled={busy}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Optional release or draft label"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <Button size="sm" disabled={busy || !name.trim()} onClick={() => void save()}>
                {doc ? "Save new version" : "Save specification"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setAnalysis(await api.specifications.validate({ ...source, workspaceId }));
                    setMessage("Draft validation complete");
                  })
                }
              >
                Validate draft
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  download("specification-bundle.json", JSON.stringify(source, null, 2), "application/json")
                }
              >
                Export bundle
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !selected}
                onClick={() => selected && download(selected.path.split("/").at(-1)!, selected.content)}
              >
                Export file
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => bundleInput.current?.click()}
              >
                Import bundle
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                Import files
              </Button>
              {doc && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Delete this specification and all saved versions?")) return;
                    void perform(async () => {
                      await api.specifications.delete(doc.specificationId);
                      setDoc(null);
                      setSource(makeSource("openapi"));
                      setFile("openapi.yaml");
                      setName("New API");
                      setAnalysis(null);
                      setDirty(false);
                      await refresh();
                      setMessage("Specification deleted");
                    });
                  }}
                >
                  Delete specification
                </Button>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label="Import specification files"
              onChange={(e) => {
                void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={bundleInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Import specification bundle"
              onChange={(e) => {
                const upload = e.target.files?.[0];
                e.target.value = "";
                if (!upload || !canLeave()) return;
                void perform(async () => {
                  if (upload.size > SPEC_LIMITS.totalBytes * 2) throw Error("Bundle upload is too large");
                  const next = specificationSource.parse(JSON.parse(await upload.text()));
                  if (doc && next.format !== doc.format)
                    throw Error("Import this format into a new specification");
                  change(next);
                  setFile(next.entrypoint);
                });
              }}
            />
            {doc && (
              <label className="text-xs block">
                Saved version
                <select
                  aria-label="Saved specification version"
                  className="border rounded p-1 ml-2 bg-background"
                  value={doc.version}
                  disabled={busy}
                  onChange={(e) => void select(doc.specificationId, Number(e.target.value))}
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
            <p className="text-xs text-muted-foreground">
              {dirty ? "Unsaved changes. " : ""}
              {oldVersion ? `Viewing v${doc.version}; saving creates v${doc.revision + 1}. ` : ""}Invalid
              drafts can be saved. Files are private to this workspace; references are resolved from the
              bundle only.
            </p>
          </section>
          {doc && (
            <SpecificationGovernancePanel
              key={doc.specificationId}
              specificationId={doc.specificationId}
              version={doc.version}
              workspaceId={workspaceId}
              disabled={busy || dirty}
              onBusyChange={setBusy}
              onFile={(path) => {
                if (source.files.some((f) => f.path === path)) setFile(path);
                else setError("This report location belongs to a different source version.");
              }}
            />
          )}
          {doc?.format === "openapi" && (
            <SpecificationCollectionsPanel
              key={doc.specificationId}
              specificationId={doc.specificationId}
              version={doc.version}
              onBusyChange={setBusy}
              disabled={busy || dirty}
              onChanged={async () => {
                load(await api.specifications.get(doc.specificationId));
                await refresh();
              }}
            />
          )}
          <section className="rounded border p-3 space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                Source file
                <select
                  aria-label="Specification source file"
                  value={file}
                  disabled={busy}
                  className="block border rounded p-2 bg-background"
                  onChange={(e) => setFile(e.target.value)}
                >
                  {source.files.map((f) => (
                    <option key={f.path}>{f.path}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                Entrypoint
                <select
                  aria-label="Specification entrypoint"
                  value={source.entrypoint}
                  disabled={busy}
                  className="block border rounded p-2 bg-background"
                  onChange={(e) => change({ ...source, entrypoint: e.target.value })}
                >
                  {source.files.map((f) => (
                    <option key={f.path}>{f.path}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                New file path
                <Input
                  aria-label="New specification file path"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="models/types.yaml"
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !fileName.trim()}
                onClick={() => {
                  try {
                    const next = specificationSource.parse({
                      ...source,
                      files: [...source.files, { path: fileName, content: "" }],
                    });
                    if (new Set(next.files.map((f) => f.path)).size !== next.files.length)
                      throw Error("File already exists");
                    change(next);
                    setFile(next.files.at(-1)!.path);
                    setFileName("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Add file
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || source.files.length === 1}
                onClick={() => {
                  const next = source.files.filter((f) => f.path !== file);
                  change({
                    ...source,
                    files: next,
                    entrypoint: source.entrypoint === file ? next[0].path : source.entrypoint,
                  });
                  setFile(next[0].path);
                }}
              >
                Remove file
              </Button>
            </div>
            <div
              className="h-[380px] border rounded overflow-hidden"
              aria-label="Specification source editor"
            >
              <CodeEditor
                value={selected?.content ?? ""}
                readOnly={busy}
                variables={false}
                language={file.endsWith(".json") ? "json" : "text"}
                onChange={(value) =>
                  change({
                    ...source,
                    files: source.files.map((f) => (f.path === file ? { ...f, content: value } : f)),
                  })
                }
              />
            </div>
          </section>
          {analysis && (
            <section className="rounded border p-3 space-y-3" aria-label="Specification analysis">
              <h2 className="font-semibold">
                {analysis.valid ? "No errors found" : "Specification diagnostics"}
              </h2>
              {analysis.truncated && (
                <p className="text-xs">
                  Result limits reached; the displayed outline/diagnostics are truncated.
                </p>
              )}
              <ul className="text-sm space-y-1">
                {analysis.diagnostics.map((d, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    <button className="underline" onClick={() => setFile(d.file)}>
                      {d.file}:{d.line}:{d.column}
                    </button>{" "}
                    · {d.severity}: {d.message}
                  </li>
                ))}
              </ul>
              <h2 className="font-semibold">Documentation preview</h2>
              <p className="font-medium">{analysis.title || name}</p>
              <p className="text-sm whitespace-pre-wrap">{analysis.description}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="max-h-72 overflow-auto space-y-1">
                  {analysis.symbols.map((s, i) => (
                    <button
                      key={i}
                      className="block w-full text-left border rounded p-2 text-xs [overflow-wrap:anywhere]"
                      onClick={() => {
                        setSelectedSymbol(`${s.file}:${s.line}:${s.name}`);
                        setFile(s.file);
                      }}
                    >
                      <span className="text-muted-foreground">{s.kind} </span>
                      {s.name}
                    </button>
                  ))}
                </div>
                {activeSymbol && (
                  <article className="p-3 bg-muted rounded min-w-0">
                    <h3 className="font-medium [overflow-wrap:anywhere]">{activeSymbol.name}</h3>
                    <p className="text-xs">
                      {activeSymbol.file}:{activeSymbol.line}:{activeSymbol.column}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{activeSymbol.description}</p>
                    <pre className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere] mt-2">
                      {activeSymbol.detail}
                    </pre>
                  </article>
                )}
              </div>
              <h2 className="font-semibold">References</h2>
              <ul className="text-xs space-y-1 max-h-48 overflow-auto">
                {analysis.references.map((r, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    {r.resolved ? "Resolved" : "Unresolved"} · {r.target} · {r.file}:{r.line}:{r.column}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
