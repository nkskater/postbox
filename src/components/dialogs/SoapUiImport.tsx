"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { SoapUiCounts, SoapUiDiagnostic } from "@/core/convert/soapui";

const COUNT_LABELS: Record<keyof SoapUiCounts, string> = {
  interfaces: "Interfaces",
  endpoints: "Endpoints",
  resources: "Resources",
  testSuites: "Test suites",
  testCases: "Test cases",
  requestDefinitions: "Saved request definitions",
  requestTestSteps: "Request test steps",
  convertedRequests: "Converted requests",
  skippedRequests: "Skipped requests",
  unsupportedTestSteps: "Unsupported steps",
  assertions: "Source assertions",
  scripts: "Source scripts",
  attachments: "Attachments",
  properties: "Source properties",
};

interface Preview {
  kind: "preview";
  name: string;
  folders: number;
  requests: number;
  variables: number;
  sourceCounts: SoapUiCounts;
  diagnostics: SoapUiDiagnostic[];
  warnings: string[];
}
interface Selection {
  content: string;
  workspaceId: string | null;
  includeCredentials: boolean;
}
const sameSelection = (a: Selection, b: Selection) =>
  a.content === b.content && a.workspaceId === b.workspaceId && a.includeCredentials === b.includeCredentials;

export function SoapUiImport({
  workspaceId,
  includeCredentials,
  disabled,
  onBusy,
  onImported,
}: {
  workspaceId: string | null;
  includeCredentials: boolean;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ selection: Selection; result: Preview } | null>(null);
  const [imported, setImported] = useState<Selection | null>(null);
  const selection = { content, workspaceId, includeCredentials };
  const current = preview && sameSelection(preview.selection, selection) ? preview.result : null;
  const persisted = imported && sameSelection(imported, selection);
  const blocked = disabled || pending;

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) {
      setError("SoapUI XML exceeds the 10 MB import limit");
      return;
    }
    setPending(true);
    onBusy(true);
    try {
      setContent(await file.text());
    } catch {
      setError("Could not read this XML file");
    } finally {
      setPending(false);
      onBusy(false);
    }
  };
  const submit = async (isPreview: boolean) => {
    if (blocked || !workspaceId || !content.trim() || (!isPreview && (!current || persisted))) return;
    const selected = selection;
    setPending(true);
    onBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selected, preview: isPreview }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "SoapUI import failed");
      if (isPreview) {
        if (result.kind !== "preview") throw new Error("The server did not return a SoapUI preview");
        setPreview({ selection: selected, result });
      } else {
        if (result.kind !== "collection" || result.source !== "soapui")
          throw new Error("The server did not return an imported SoapUI collection");
        // Mark the committed import before refreshing the sidebar so a refresh
        // failure cannot invite a duplicate import of already-persisted data.
        setImported(selected);
        try {
          await onImported();
        } catch {
          setError(
            "Imported successfully, but the sidebar could not refresh. Reopen the workspace to reload it.",
          );
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
      onBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="SoapUI migration">
      <p className="text-xs text-muted-foreground">
        Upload or paste a SoapUI project XML file. Preview requests, source counts and unsupported features
        before importing. Recognized credentials and secret properties are omitted unless you enable their
        inclusion above.
      </p>
      <Input
        aria-label="SoapUI project file"
        type="file"
        accept=".xml,text/xml,application/xml"
        disabled={blocked}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void loadFile(file);
        }}
      />
      <Textarea
        aria-label="SoapUI project XML"
        className="h-40 font-mono text-xs"
        placeholder="Paste SoapUI project XML"
        value={content}
        disabled={blocked}
        onChange={(event) => {
          setContent(event.target.value);
          setError(null);
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          disabled={blocked || !content.trim() || !workspaceId}
          onClick={() => void submit(true)}
        >
          {pending && <Loader2 className="size-4 animate-spin" />} Preview SoapUI
        </Button>
        <Button disabled={blocked || !current || !!persisted} onClick={() => void submit(false)}>
          Import SoapUI
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {persisted && (
        <p role="status" className="text-xs text-emerald-500">
          Imported SoapUI collection successfully.
        </p>
      )}
      {current && (
        <div
          className="max-h-64 space-y-3 overflow-auto rounded border p-3 text-xs"
          role="region"
          aria-label="SoapUI import preview"
        >
          <p className="font-medium">
            {current.name}: {current.requests} requests, {current.folders} folders, {current.variables}{" "}
            variables
          </p>
          <p>
            Credentials:{" "}
            {includeCredentials
              ? "included as secret variables where recognized"
              : "recognized values omitted"}
            . Source assertions and scripts are not Postbox tests.
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(current.sourceCounts).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt>{COUNT_LABELS[key as keyof SoapUiCounts] ?? key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="space-y-2">
            {current.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>
                <span className="font-medium">{diagnostic.path}</span>: {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!current && preview && (
        <p className="text-xs text-muted-foreground">
          The source, workspace or credential choice changed. Preview again before importing.
        </p>
      )}
    </section>
  );
}
