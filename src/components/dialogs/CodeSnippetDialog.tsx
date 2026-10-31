"use client";
/**
 * Code snippet generator for the active request.
 */
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/editor/CodeEditor";
import {
  CODEGEN_LANGUAGES,
  type CodegenLanguage,
  type CodegenOptions,
  type CodegenOption,
} from "@/core/convert/codegen-targets";
import { Input } from "@/components/ui/input";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";

export function CodeSnippetDialog() {
  const tabId = useDialogs((s) => s.codeTabId);
  const openCode = useDialogs((s) => s.openCode);
  const tab = useApp((s) => s.tabs.find((t) => t.id === tabId));
  const workspaceId = useApp((s) => s.workspaceId);
  const environmentId = useApp((s) => s.environmentId);
  const [lang, setLang] = useState<CodegenLanguage>("curl");
  const [resolve, setResolve] = useState(true);
  const [options, setOptions] = useState<CodegenOptions>({});
  const [result, setResult] = useState<{
    key: string;
    code: string;
    warnings: string[];
    error: string | null;
  } | null>(null);
  const target = CODEGEN_LANGUAGES.find((t) => t.id === lang)!;
  const draft = tab?.type === "request" ? tab.draft : null;
  const generationKey = JSON.stringify({ draft, lang, options, resolve, workspaceId, environmentId, tabId });
  const current = result?.key === generationKey ? result : null;
  const code = current?.code ?? "";
  const warnings = current?.warnings ?? [];
  const error = current?.error ?? null;
  const loading = !!draft && !!workspaceId && !current;

  useEffect(() => {
    if (!draft || !workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    const { folderId, ...request } = draft;
    fetch("/api/codegen", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        environmentId,
        folderId,
        request,
        language: lang,
        options,
        resolveVariables: resolve,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(data.error);
        setResult({ key: generationKey, code: data.code, warnings: data.warnings ?? [], error: null });
      })
      .catch(
        (e) => !cancelled && setResult({ key: generationKey, code: "", warnings: [], error: e.message }),
      );
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationKey]);

  const language = CODEGEN_LANGUAGES.find((l) => l.id === lang)?.editor ?? "text";

  return (
    <Dialog open={!!tabId} onOpenChange={(o) => !o && openCode(null)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Code snippet</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 text-xs">
          <Select
            value={lang}
            onValueChange={(v) => {
              setLang(v as CodegenLanguage);
              setOptions({});
            }}
          >
            <SelectTrigger aria-label="Snippet target" size="sm" className="w-64 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODEGEN_LANGUAGES.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-xs">
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2">
            <Switch checked={resolve} onCheckedChange={setResolve} /> Resolve variables
          </label>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 text-xs"
            disabled={loading || !!error || !code}
            onClick={() => {
              void navigator.clipboard.writeText(code).then(
                () => toast.success("Copied"),
                () => toast.error("Could not copy snippet"),
              );
            }}
          >
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer">Code settings</summary>
          <div className="mt-3 grid max-h-48 grid-cols-2 gap-3 overflow-auto">
            {(target.options as readonly CodegenOption[]).map((option) => {
              const value = options[option.id] ?? option.default;
              const update = (next: string | number | boolean) =>
                setOptions((current) => ({ ...current, [option.id]: next }));
              return (
                <label
                  key={option.id}
                  className="flex items-center justify-between gap-2"
                  title={option.description}
                >
                  <span>{option.name}</span>
                  {option.type === "boolean" ? (
                    <Switch aria-label={option.name} checked={value === true} onCheckedChange={update} />
                  ) : option.type === "enum" ? (
                    <Select value={String(value)} onValueChange={update}>
                      <SelectTrigger aria-label={option.name} size="sm" className="w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {option.availableOptions!.map((choice) => (
                          <SelectItem key={choice} value={choice}>
                            {choice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={option.name}
                      type="number"
                      min={option.id === "indentCount" ? 1 : 0}
                      max={option.id === "indentCount" ? 8 : 3600000}
                      className="h-7 w-24 text-xs"
                      value={Number(value)}
                      onChange={(e) => update(Number(e.target.value))}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </details>
        {warnings.map((warning) => (
          <p key={warning} className="text-[11px] text-warning">
            {warning}
          </p>
        ))}
        {resolve && (
          <p className="text-[11px] text-warning">
            Resolved snippets may contain secret values. Treat them like credentials.
          </p>
        )}
        <div className="h-96 overflow-hidden rounded-md border">
          {loading ? (
            <p className="p-4 text-muted-foreground" role="status">
              Generating snippet…
            </p>
          ) : error ? (
            <div className="p-4 text-destructive">{error}</div>
          ) : (
            <CodeEditor value={code} language={language} readOnly wrap />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
