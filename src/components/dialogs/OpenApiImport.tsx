"use client";
import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OpenApiFile, ReferenceDiagnostic, ReferenceSummary } from "@/core/convert/openapi-references";

interface Preview {
  kind: "preview";
  source: "openapi";
  name: string;
  folders: number;
  requests: number;
  variables: number;
  references: ReferenceSummary;
  diagnostics: ReferenceDiagnostic[];
}
export function OpenApiImport({
  workspaceId,
  disabled,
  onBusy,
  onImported,
}: {
  workspaceId: string | null;
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [mode, setMode] = useState("files");
  const [files, setFiles] = useState<OpenApiFile[]>([]);
  const [entrypoint, setEntrypoint] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [origins, setOrigins] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ReferenceDiagnostic[]>([]);
  const [preview, setPreview] = useState<{ key: string; result: Preview } | null>(null);
  const [persisted, setPersisted] = useState<string | null>(null);
  const input = {
    workspaceId,
    ...(mode === "files" ? { files, entrypoint } : mode === "url" ? { url } : { content }),
    ...(mode !== "url" && sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
    allowedRefOrigins: origins.split(/[\s,]+/).filter(Boolean),
  };
  const key = JSON.stringify(input);
  const current = preview?.key === key ? preview.result : null;
  const blocked = disabled || pending;
  const ready =
    !!workspaceId &&
    (mode === "files" ? files.length > 0 && !!entrypoint : mode === "url" ? !!url.trim() : !!content.trim());
  const changed = () => {
    setError(null);
    setDiagnostics([]);
  };
  const loadFiles = async (selected: File[]) => {
    if (inFlight.current || disabled || !selected.length) return;
    changed();
    setPreview(null);
    setFiles([]);
    setEntrypoint("");
    const source = selected.filter((file) => /\.(json|ya?ml)$/i.test(file.name));
    if (
      !source.length ||
      source.length > 100 ||
      source.some((f) => f.size > 5 * 1024 * 1024) ||
      source.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024
    ) {
      setError("Choose 1–100 JSON/YAML files, at most 5 MB each and 20 MB total.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    onBusy(true);
    try {
      const loaded = await Promise.all(
        source.map(async (file) => ({
          path: file.webkitRelativePath || file.name,
          content: await file.text(),
        })),
      );
      if (new Set(loaded.map((f) => f.path)).size !== loaded.length)
        throw new Error("Duplicate filenames. Use Choose folder to preserve relative paths.");
      setFiles(loaded);
      setEntrypoint(
        loaded.find((f) => /(^|\/)(openapi|swagger)\.(json|ya?ml)$/i.test(f.path))?.path ?? loaded[0].path,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the selected files");
    } finally {
      inFlight.current = false;
      setPending(false);
      onBusy(false);
    }
  };
  const submit = async (isPreview: boolean) => {
    if (blocked || inFlight.current || !ready || (!isPreview && (!current || persisted === key))) return;
    const selectedKey = key;
    inFlight.current = true;
    setPending(true);
    onBusy(true);
    setError(null);
    setDiagnostics([]);
    if (isPreview) setPreview(null);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, preview: isPreview }),
      });
      const result = await response.json();
      setDiagnostics(result.diagnostics ?? []);
      if (!response.ok) throw new Error(result.error || "OpenAPI import failed");
      if (result.source !== "openapi" || result.kind !== (isPreview ? "preview" : "collection"))
        throw new Error("Expected an OpenAPI document");
      if (isPreview) setPreview({ key: selectedKey, result });
      else {
        setPersisted(selectedKey);
        try {
          await onImported();
        } catch {
          setError("Imported successfully. Reopen the workspace to refresh the sidebar.");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "OpenAPI import failed");
    } finally {
      inFlight.current = false;
      setPending(false);
      onBusy(false);
    }
  };
  const deniedOrigins = [
    ...new Set(diagnostics.filter((d) => d.code === "origin-not-approved" && d.origin).map((d) => d.origin!)),
  ];
  return (
    <section aria-label="OpenAPI bundle import" className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Import one OpenAPI document with all its referenced files. Choose folder to preserve subdirectories.
        Preview resolves the full graph before saving any requests.
      </p>
      <label className="block space-y-1 text-xs">
        Source
        <select
          aria-label="OpenAPI source"
          className="block w-full rounded border bg-background p-2"
          value={mode}
          disabled={blocked}
          onChange={(e) => {
            setMode(e.target.value);
            changed();
          }}
        >
          <option value="files">Files or folder</option>
          <option value="text">Paste JSON / YAML</option>
          <option value="url">URL</option>
        </select>
      </label>
      {mode === "files" && (
        <div className="space-y-2">
          <label className="block text-xs">
            Choose files
            <Input
              aria-label="OpenAPI files"
              type="file"
              multiple
              accept=".json,.yaml,.yml"
              disabled={blocked}
              onChange={(e) => {
                const selected = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                void loadFiles(selected);
              }}
            />
          </label>
          <label className="block text-xs">
            Choose folder
            <Input
              aria-label="OpenAPI folder"
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              disabled={blocked}
              onChange={(e) => {
                const selected = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                void loadFiles(selected);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {files.length} files selected. Limits: 100 files, 5 MB each, 20 MB total.
          </p>
          {!!files.length && (
            <label className="block space-y-1 text-xs">
              Entrypoint
              <select
                aria-label="OpenAPI entrypoint"
                className="block w-full rounded border bg-background p-2"
                value={entrypoint}
                disabled={blocked}
                onChange={(e) => {
                  setEntrypoint(e.target.value);
                  changed();
                }}
              >
                {files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {mode === "text" && (
        <Textarea
          aria-label="OpenAPI document"
          className="h-36 font-mono text-xs"
          placeholder="Paste the root OpenAPI JSON or YAML"
          value={content}
          disabled={blocked}
          onChange={(e) => {
            setContent(e.target.value);
            changed();
          }}
        />
      )}
      {mode === "url" ? (
        <Input
          aria-label="OpenAPI URL"
          placeholder="https://api.example/spec/openapi.yaml"
          value={url}
          disabled={blocked}
          onChange={(e) => {
            setUrl(e.target.value);
            changed();
          }}
        />
      ) : (
        <label className="block space-y-1 text-xs">
          Original document URL (optional)
          <Input
            aria-label="OpenAPI original URL"
            placeholder="https://api.example/spec/openapi.yaml"
            value={sourceUrl}
            disabled={blocked}
            onChange={(e) => {
              setSourceUrl(e.target.value);
              changed();
            }}
          />
        </label>
      )}
      <label className="block space-y-1 text-xs">
        Approved reference origins (optional)
        <Textarea
          aria-label="Approved reference origins"
          className="h-16 font-mono text-xs"
          placeholder="https://schemas.example.com (one origin per line)"
          value={origins}
          disabled={blocked}
          onChange={(e) => {
            setOrigins(e.target.value);
            changed();
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Reference downloads require explicit origin approval, including redirects. Server host rules also
        apply. Imported examples are depth-limited when schemas are recursive.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={blocked || !ready} onClick={() => void submit(true)}>
          {pending && <Loader2 className="size-4 animate-spin" />}Preview OpenAPI
        </Button>
        <Button disabled={blocked || !current || persisted === key} onClick={() => void submit(false)}>
          Import OpenAPI
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {deniedOrigins.map((origin) => (
        <Button
          key={origin}
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={() => {
            setOrigins([...new Set([...input.allowedRefOrigins, origin])].join("\n"));
            changed();
          }}
        >
          Allow downloads from {origin}
        </Button>
      ))}
      {persisted === key && (
        <p role="status" className="text-xs text-emerald-500">
          Imported OpenAPI collection successfully.
        </p>
      )}
      {current && (
        <div
          role="region"
          aria-label="OpenAPI import preview"
          className="rounded border p-3 text-xs space-y-2"
        >
          <p className="font-medium">
            {current.name}: {current.requests} requests, {current.folders} folders, {current.variables}{" "}
            variables
          </p>
          <p>
            {current.references.documents} documents, {current.references.references} references,{" "}
            {current.references.remoteFetches} remote downloads, {current.references.cycles} cycles.
          </p>
          <p>
            Confirm to save this collection. Preview does not save data; remote documents are fetched again at
            import time.
          </p>
        </div>
      )}
      {!current && preview && (
        <p className="text-xs text-muted-foreground">
          The source, workspace or reference approvals changed. Preview again before importing.
        </p>
      )}
      {!!diagnostics.length && (
        <ul
          aria-label="OpenAPI reference diagnostics"
          className="max-h-48 overflow-auto space-y-2 rounded border p-3 text-xs"
        >
          {diagnostics.map((d, i) => (
            <li key={`${d.code}-${i}`}>
              <span className="font-medium">{d.code}</span>: {d.message}
              <div className="break-all font-mono text-muted-foreground">
                {d.source}
                {d.path ? `#${d.path}` : ""}
                {d.target ? ` → ${d.target}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
