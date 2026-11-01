"use client";
/** Edit a set of .proto files: paste, add, rename, remove and upload. Used for a request's own files and for shared sets. */
import { toast } from "sonner";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nextProtoName, renameProto } from "@/lib/grpc";

export function ProtoFilesEditor({
  files,
  onChange,
  disabled,
}: {
  files: Record<string, string>;
  onChange: (files: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const entries = Object.entries(files);
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    let next = { ...files };
    for (const file of Array.from(list)) {
      if (file.size > 1_048_576) {
        toast.error(`${file.name} is larger than 1 MiB`);
        continue;
      }
      next = { ...next, [file.name]: await file.text() };
    }
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {entries.map(([name, text]) => (
        <div key={name} className="rounded-md border">
          <div className="flex items-center gap-2 border-b px-2 py-1">
            <input
              className="h-7 w-56 rounded-md border bg-transparent px-2 font-mono text-xs"
              aria-label="Proto file name"
              defaultValue={name}
              disabled={disabled}
              onBlur={(e) => {
                if (e.target.value !== name) {
                  const next = renameProto(files, name, e.target.value);
                  if (next === files) e.target.value = name;
                  else onChange(next);
                }
              }}
            />
            <span className="text-muted-foreground">{text.length.toLocaleString()} chars</span>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto size-6"
              aria-label={`Remove ${name}`}
              disabled={disabled}
              onClick={() => {
                const { [name]: _removed, ...rest } = files;
                onChange(rest);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <Textarea
            className="min-h-28 rounded-none border-0 font-mono text-xs"
            aria-label={`${name} contents`}
            spellCheck={false}
            disabled={disabled}
            value={text}
            onChange={(e) => onChange({ ...files, [name]: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={disabled}
          onClick={() => onChange({ ...files, [nextProtoName(files)]: "" })}
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
            disabled={disabled}
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
  );
}
