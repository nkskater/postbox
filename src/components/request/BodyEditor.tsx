"use client";
import { GraphqlBodyEditor } from "./GraphqlBodyEditor";
/**
 * Request body editor: none / raw (JSON, XML, text, HTML, JS) / form-data /
 * x-www-form-urlencoded / binary / GraphQL.
 */
import { FileUp, Wand2 } from "lucide-react";
import type { BodyConfig, BodyMode, RawLanguage, RequestDef } from "@/core/types";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "./KeyValueEditor";
import { cn } from "@/lib/utils";
import { getSetting } from "@/lib/settings/runtime";
import { formatXml } from "@/lib/format";
import { toast } from "sonner";
import { MAX_UPLOAD_BYTES } from "@/core/retention";

const MODES: { mode: BodyMode; label: string }[] = [
  { mode: "none", label: "none" },
  { mode: "formdata", label: "form-data" },
  { mode: "urlencoded", label: "x-www-form-urlencoded" },
  { mode: "raw", label: "raw" },
  { mode: "binary", label: "binary" },
  { mode: "graphql", label: "GraphQL" },
];

const LANGS: { value: RawLanguage; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "text", label: "Text" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "javascript", label: "JavaScript" },
];

/** Switch modes while keeping data from other modes when possible. */
export function switchBodyMode(body: BodyConfig, mode: BodyMode): BodyConfig {
  switch (mode) {
    case "none":
      return { mode: "none" };
    case "raw":
      return {
        mode: "raw",
        raw: body.mode === "raw" ? body.raw : "",
        language:
          body.mode === "raw"
            ? body.language
            : getSetting<RawLanguage>("requests.defaultRawLanguage") || "json",
      };
    case "urlencoded":
      return {
        mode: "urlencoded",
        urlencoded: body.mode === "formdata" ? body.formdata.filter((f) => f.type === "text") : [],
      };
    case "formdata":
      return {
        mode: "formdata",
        formdata:
          body.mode === "urlencoded" ? body.urlencoded.map((kv) => ({ ...kv, type: "text" as const })) : [],
      };
    case "binary":
      return { mode: "binary", binary: null };
    case "graphql":
      return { mode: "graphql", graphql: { query: "", variables: "" } };
  }
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function BodyEditor({
  body,
  onChange,
  draft,
}: {
  body: BodyConfig;
  onChange: (b: BodyConfig) => void;
  /** The whole request, so GraphQL introspection can reuse its URL, headers and auth. */
  draft?: RequestDef & { folderId?: string | null };
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {MODES.map((m) => (
          <label key={m.mode} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              className="accent-primary"
              checked={body.mode === m.mode}
              onChange={() => onChange(switchBodyMode(body, m.mode))}
            />
            <span className={cn(body.mode === m.mode ? "text-foreground" : "text-muted-foreground")}>
              {m.label}
            </span>
          </label>
        ))}
        {body.mode === "raw" && (
          <>
            <Select
              value={body.language}
              onValueChange={(language) => onChange({ ...body, language: language as RawLanguage })}
            >
              <SelectTrigger size="sm" className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGS.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(body.language === "json" || body.language === "xml") && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => {
                  try {
                    const raw =
                      body.language === "json"
                        ? JSON.stringify(JSON.parse(body.raw), null, 2)
                        : formatXml(body.raw);
                    onChange({ ...body, raw });
                  } catch {
                    /* leave invalid content untouched */
                  }
                }}
              >
                <Wand2 className="size-3.5" /> Beautify
              </Button>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {body.mode === "none" && (
          <p className="p-4 text-center text-xs text-muted-foreground">This request does not have a body</p>
        )}
        {body.mode === "raw" && (
          <div className="h-full overflow-hidden rounded-md border">
            <CodeEditor
              value={body.raw}
              language={body.language}
              onChange={(raw) => onChange({ ...body, raw })}
            />
          </div>
        )}
        {body.mode === "urlencoded" && (
          <KeyValueEditor
            rows={body.urlencoded}
            onChange={(urlencoded) => onChange({ ...body, urlencoded })}
            showDescription
          />
        )}
        {body.mode === "formdata" && (
          <KeyValueEditor
            rows={body.formdata}
            files
            onChange={(formdata) => onChange({ ...body, formdata })}
          />
        )}
        {body.mode === "binary" && (
          <label className="flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground hover:border-primary">
            <FileUp className="size-5" />
            <span>
              {body.binary
                ? body.binary.missing
                  ? `${body.binary.fileName} (reselect to attach)`
                  : `${body.binary.fileName} (${Math.round((body.binary.data.length * 3) / 4 / 1024)} KB)`
                : "Select a file"}
            </span>
            <input
              type="file"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file && file.size > MAX_UPLOAD_BYTES) {
                  toast.error("Request uploads must total 5 MiB or less");
                  e.currentTarget.value = "";
                } else if (file)
                  onChange({
                    mode: "binary",
                    binary: {
                      fileName: file.name,
                      contentType: file.type,
                      data: await readFile(file),
                      missing: false,
                    },
                  });
              }}
            />
          </label>
        )}
        {body.mode === "graphql" && <GraphqlBodyEditor body={body} onChange={onChange} draft={draft} />}
      </div>
    </div>
  );
}
