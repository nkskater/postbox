"use client";
/**
 * Editable key/value table (params, headers, urlencoded, form-data) with
 * enable toggles, a trailing "add" row and a bulk-edit text mode.
 */
import { useState } from "react";
import { Trash2, FileUp, Text } from "lucide-react";
import type { FormDataField, KeyValue } from "@/core/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { VarInput } from "@/components/editor/VarInput";
import { cn } from "@/lib/utils";

type Row = KeyValue | FormDataField;

export interface KeyValueEditorProps<T extends Row> {
  rows: T[];
  onChange: (rows: T[]) => void;
  /** Allow file rows (multipart form-data). */
  files?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Read-only rows rendered above (e.g. inherited headers). */
  inherited?: { key: string; value: string; source: string }[];
  showDescription?: boolean;
}

const empty = (files?: boolean): Row =>
  files ? { key: "", value: "", enabled: true, type: "text" } : { key: "", value: "", enabled: true };

function toBulk(rows: Row[]): string {
  return rows
    .filter((r) => r.key || r.value)
    .map((r) => `${r.enabled ? "" : "//"}${r.key}:${r.value}`)
    .join("\n");
}

function fromBulk(text: string, files?: boolean): Row[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const disabled = line.startsWith("//");
      const l = disabled ? line.slice(2) : line;
      const i = l.indexOf(":");
      const key = (i >= 0 ? l.slice(0, i) : l).trim();
      const value = i >= 0 ? l.slice(i + 1).trim() : "";
      return files
        ? { key, value, enabled: !disabled, type: "text" as const }
        : { key, value, enabled: !disabled };
    });
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function KeyValueEditor<T extends Row>({
  rows,
  onChange,
  files,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  inherited,
  showDescription,
}: KeyValueEditorProps<T>) {
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const all = [...rows, empty(files) as T];

  const update = (index: number, patch: Partial<Row>) => {
    const next = all.map((r, i) => (i === index ? ({ ...r, ...patch } as T) : r));
    onChange(
      next.filter((r, i) => i < rows.length || r.key || r.value || ("type" in r && r.type === "file")),
    );
  };
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={() => {
            if (!bulk) setBulkText(toBulk(rows));
            else onChange(fromBulk(bulkText, files) as T[]);
            setBulk(!bulk);
          }}
        >
          {bulk ? "Key-Value Edit" : "Bulk Edit"}
        </Button>
      </div>
      {bulk ? (
        <Textarea
          className="min-h-48 font-mono text-xs"
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          onBlur={() => onChange(fromBulk(bulkText, files) as T[])}
          placeholder={"key:value\n//disabled:value"}
        />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <div
            className={cn(
              "grid items-center gap-px border-b bg-muted/40 px-1 py-1 text-[11px] font-medium text-muted-foreground",
              showDescription ? "grid-cols-[28px_1fr_1fr_1fr_32px]" : "grid-cols-[28px_1fr_1fr_32px]",
            )}
          >
            <span />
            <span className="px-2">{keyPlaceholder}</span>
            <span className="px-2">{valuePlaceholder}</span>
            {showDescription && <span className="px-2">Description</span>}
            <span />
          </div>
          {inherited?.map((h, i) => (
            <div
              key={`inh-${i}`}
              className="grid grid-cols-[28px_1fr_1fr_32px] items-center gap-1 border-b px-1 py-0.5 text-muted-foreground"
              title={`Inherited from ${h.source}`}
            >
              <span className="text-center text-[10px]">⇣</span>
              <span className="truncate px-2 font-mono">{h.key}</span>
              <span className="truncate px-2 font-mono">{h.value}</span>
              <span className="truncate text-[10px]">{h.source}</span>
            </div>
          ))}
          {all.map((row, i) => {
            const isNew = i === rows.length;
            const isFile = "type" in row && row.type === "file";
            return (
              <div
                key={i}
                className={cn(
                  "group grid items-center gap-1 border-b px-1 py-0.5 last:border-b-0",
                  showDescription ? "grid-cols-[28px_1fr_1fr_1fr_32px]" : "grid-cols-[28px_1fr_1fr_32px]",
                  !row.enabled && !isNew && "opacity-50",
                )}
              >
                <div className="flex justify-center">
                  {!isNew && (
                    <Checkbox checked={row.enabled} onCheckedChange={(v) => update(i, { enabled: !!v })} />
                  )}
                </div>
                <VarInput
                  value={row.key}
                  onChange={(key) => update(i, { key })}
                  placeholder={keyPlaceholder}
                  className="h-7 border-transparent hover:border-input"
                />
                <div className="flex min-w-0 items-center gap-1">
                  {isFile ? (
                    <label className="flex h-7 flex-1 cursor-pointer items-center gap-2 truncate rounded-md border border-dashed px-2 text-muted-foreground hover:border-input">
                      <FileUp className="size-3.5 shrink-0" />
                      <span className="truncate">{(row as FormDataField).fileName || "Choose file…"}</span>
                      <input
                        type="file"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const data = await readFileBase64(file);
                          update(i, {
                            fileName: file.name,
                            contentType: file.type || "application/octet-stream",
                            data,
                          } as Partial<FormDataField>);
                        }}
                      />
                    </label>
                  ) : (
                    <VarInput
                      value={row.value}
                      onChange={(value) => update(i, { value })}
                      placeholder={valuePlaceholder}
                      className="h-7 flex-1 border-transparent hover:border-input"
                    />
                  )}
                  {files && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground"
                      title={isFile ? "Switch to text" : "Switch to file"}
                      onClick={() =>
                        update(i, { type: isFile ? "text" : "file", value: "" } as Partial<FormDataField>)
                      }
                    >
                      {isFile ? <Text className="size-3.5" /> : <FileUp className="size-3.5" />}
                    </Button>
                  )}
                </div>
                {showDescription && (
                  <VarInput
                    value={row.description ?? ""}
                    onChange={(description) => update(i, { description })}
                    placeholder="Description"
                    className="h-7 border-transparent hover:border-input"
                  />
                )}
                <div className="flex justify-center">
                  {!isNew && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100"
                      onClick={() => remove(i)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
