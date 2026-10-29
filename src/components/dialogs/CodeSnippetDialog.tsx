"use client";
/**
 * Code snippet generator for the active request (cURL, fetch, Python, PowerShell).
 */
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { CODEGEN_LANGUAGES, type CodegenLanguage } from "@/core/convert/codegen";
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
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const draft = tab?.type === "request" ? tab.draft : null;
  const draftKey = draft ? JSON.stringify(draft) : "";

  useEffect(() => {
    if (!draft || !workspaceId) return;
    let cancelled = false;
    const { folderId, ...request } = draft;
    fetch("/api/codegen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        environmentId,
        folderId,
        request,
        language: lang,
        resolveVariables: resolve,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(data.error);
        setCode(data.code);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, lang, resolve, workspaceId, environmentId]);

  const language = CODEGEN_LANGUAGES.find((l) => l.id === lang)?.editor ?? "text";

  return (
    <Dialog open={!!tabId} onOpenChange={(o) => !o && openCode(null)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Code snippet</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 text-xs">
          <Select value={lang} onValueChange={(v) => setLang(v as CodegenLanguage)}>
            <SelectTrigger size="sm" className="w-64 text-xs">
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
            onClick={() => {
              void navigator.clipboard.writeText(code);
              toast.success("Copied");
            }}
          >
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
        {resolve && (
          <p className="text-[11px] text-warning">
            Resolved snippets may contain secret values. Treat them like credentials.
          </p>
        )}
        <div className="h-96 overflow-hidden rounded-md border">
          {error ? (
            <div className="p-4 text-destructive">{error}</div>
          ) : (
            <CodeEditor value={code} language={language} readOnly wrap />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
