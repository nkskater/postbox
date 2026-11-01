"use client";
/** gRPC request tab: proto files, a shared definition or reflection; method discovery and selection. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/stores/app";
import type { GrpcSettings, RequestDef } from "@/core/types";
import { emptyGrpc, methodOptions, type GrpcServiceSummary } from "@/lib/grpc";
import { ProtoFilesEditor } from "./ProtoFilesEditor";
import { SaveAsShared, SharedDefinitionPanel } from "./SharedDefinitions";

const field = "h-7 rounded-md border bg-transparent px-2 text-xs";

export function GrpcEditor({
  draft,
  onSettings,
}: {
  draft: RequestDef & { folderId?: string | null };
  onSettings: (grpc: GrpcSettings) => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const grpc = draft.settings.grpc ?? emptyGrpc();
  const files = Object.entries(grpc.protos);
  const [services, setServices] = useState<GrpcServiceSummary[] | null>(null);
  const [mode, setMode] = useState<"files" | "shared" | "reflection">(
    grpc.reflection ? "reflection" : grpc.definitionId ? "shared" : "files",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<GrpcSettings>) => onSettings({ ...grpc, ...patch });
  const options = services ? methodOptions(services) : [];
  const selected = grpc.service && grpc.method ? `${grpc.service}/${grpc.method}` : "";
  const selectedOption = options.find(
    (o) => o.value === selected || (o.method === grpc.method && o.service.endsWith(grpc.service)),
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { folderId, ...request } = draft;
      const res = grpc.reflection
        ? await fetch("/api/grpc/reflect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId, environmentId, folderId, request }),
          })
        : await fetch("/api/grpc/describe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              grpc.definitionId
                ? { workspaceId, definitionId: grpc.definitionId }
                : { workspaceId, protos: grpc.protos },
            ),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      const list = body.services as GrpcServiceSummary[];
      setServices(list);
      const first = list.flatMap((s) => s.methods.map((m) => ({ service: s.fullName, method: m.name })))[0];
      const stillThere = list.some(
        (s) => s.fullName === grpc.service && s.methods.some((m) => m.name === grpc.method),
      );
      if (first && !stillThere) update({ service: first.service, method: first.method });
      if (!first) setError("No services were found");
    } catch (err) {
      setServices(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-4">
        {(
          [
            ["files", "Proto files"],
            ["shared", "Shared definition"],
            ["reflection", "Server reflection"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1">
            <input
              type="radio"
              name="grpc-source"
              checked={mode === value}
              onChange={() => {
                setMode(value);
                setServices(null);
                update({
                  reflection: value === "reflection" ? true : undefined,
                  definitionId: value === "shared" ? grpc.definitionId : undefined,
                });
              }}
            />
            {label}
          </label>
        ))}
      </div>

      {mode === "reflection" && (
        <p className="text-muted-foreground">
          Definitions are fetched from the server at the URL above using its reflection service. Headers and
          authorization are sent with the request.
        </p>
      )}
      {mode === "shared" && workspaceId && (
        <SharedDefinitionPanel
          workspaceId={workspaceId}
          definitionId={grpc.definitionId}
          onSelect={(definitionId) => {
            setServices(null);
            update({ definitionId, protos: {}, reflection: undefined });
          }}
          onChanged={() => void load()}
        />
      )}
      {mode === "files" && (
        <div className="space-y-2">
          <ProtoFilesEditor files={grpc.protos} onChange={(protos) => update({ protos })} />
          {files.length > 0 && workspaceId && (
            <SaveAsShared
              workspaceId={workspaceId}
              files={grpc.protos}
              onSaved={(definitionId) => {
                setMode("shared");
                setServices(null);
                update({ definitionId, protos: {}, reflection: undefined });
              }}
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          className="h-7"
          disabled={
            loading || (mode === "files" && files.length === 0) || (mode === "shared" && !grpc.definitionId)
          }
          onClick={() => void load()}
        >
          {loading ? "Loading…" : mode === "reflection" ? "Discover methods" : "Load methods"}
        </Button>
        <select
          className={`${field} min-w-64 font-mono`}
          aria-label="Method"
          value={selectedOption ? selectedOption.value : selected}
          disabled={options.length === 0 && !selected}
          onChange={(e) => {
            const option = options.find((o) => o.value === e.target.value);
            if (option) update({ service: option.service, method: option.method });
          }}
        >
          {!selectedOption && <option value={selected}>{selected || "Load methods to choose one"}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} · {o.kind}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p className="text-muted-foreground">
        Write the message as JSON in the Body tab (an array for client or bidirectional streaming). Headers
        become call metadata, and Timeout is the call deadline. int64 values are strings, bytes are base64.
      </p>
    </div>
  );
}
