"use client";
/** gRPC request tab: proto files or reflection, method discovery and selection. */
import { useState } from "react";
import { toast } from "sonner";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/stores/app";
import type { GrpcSettings, RequestDef } from "@/core/types";
import { emptyGrpc, methodOptions, nextProtoName, renameProto, type GrpcServiceSummary } from "@/lib/grpc";

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
            body: JSON.stringify({ workspaceId, protos: grpc.protos }),
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

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    let protos = { ...grpc.protos };
    for (const file of Array.from(list)) {
      if (file.size > 1_048_576) {
        toast.error(`${file.name} is larger than 1 MiB`);
        continue;
      }
      protos = { ...protos, [file.name]: await file.text() };
    }
    update({ protos });
  };

  return (
    <div className="max-w-3xl space-y-3 text-xs">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="grpc-source"
            checked={!grpc.reflection}
            onChange={() => update({ reflection: undefined })}
          />
          Proto files
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="grpc-source"
            checked={!!grpc.reflection}
            onChange={() => update({ reflection: true })}
          />
          Server reflection
        </label>
      </div>

      {grpc.reflection ? (
        <p className="text-muted-foreground">
          Definitions are fetched from the server at the URL above using its reflection service. Headers and
          authorization are sent with the request.
        </p>
      ) : (
        <div className="space-y-2">
          {files.map(([name, text]) => (
            <div key={name} className="rounded-md border">
              <div className="flex items-center gap-2 border-b px-2 py-1">
                <input
                  className={`${field} w-56 font-mono`}
                  aria-label="Proto file name"
                  defaultValue={name}
                  onBlur={(e) => {
                    if (e.target.value !== name) {
                      const next = renameProto(grpc.protos, name, e.target.value);
                      if (next === grpc.protos) e.target.value = name;
                      else update({ protos: next });
                    }
                  }}
                />
                <span className="text-muted-foreground">{text.length.toLocaleString()} chars</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-auto size-6"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    const { [name]: _removed, ...rest } = grpc.protos;
                    update({ protos: rest });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Textarea
                className="min-h-28 rounded-none border-0 font-mono text-xs"
                aria-label={`${name} contents`}
                spellCheck={false}
                value={text}
                onChange={(e) => update({ protos: { ...grpc.protos, [name]: e.target.value } })}
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => update({ protos: { ...grpc.protos, [nextProtoName(grpc.protos)]: "" } })}
            >
              <Plus className="size-3.5" /> Add file
            </Button>
            <label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 hover:bg-accent">
              <FileUp className="size-3.5" /> Upload .proto
              <input
                type="file"
                accept=".proto,text/plain"
                multiple
                className="sr-only"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="text-muted-foreground">
              Imports resolve against these files and the built-in google/protobuf types.
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          className="h-7"
          disabled={loading || (!grpc.reflection && files.length === 0)}
          onClick={() => void load()}
        >
          {loading ? "Loading…" : grpc.reflection ? "Discover methods" : "Load methods"}
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
