"use client";
/**
 * Import Postman collections/environments, OpenAPI/Swagger specs (file, text or link)
 * and cURL commands (opened as a new request tab).
 */
import { useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { parseCurl } from "@/core/convert/curl";
import { paramsFromUrl } from "@/lib/url-params";
import { DEFAULT_SETTINGS } from "@/core/types";

interface Outcome {
  kind: "collection" | "environment" | "globals";
  name?: string;
  requests?: number;
  variables?: number;
}

export function ImportDialog() {
  const open = useDialogs((s) => s.importOpen);
  const setOpen = useDialogs((s) => s.setImportOpen);
  const { workspaceId, refreshTree, refreshEnvironments, refreshVariables, openDraft } = useApp();
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const report = (o: Outcome) => {
    if (o.kind === "collection") toast.success(`Imported collection "${o.name}" (${o.requests} requests)`);
    else if (o.kind === "environment")
      toast.success(`Imported environment "${o.name}" (${o.variables} variables)`);
    else toast.success(`Imported ${o.variables} global variables`);
  };

  const send = async (body: Record<string, string>) => {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    report(data);
  };

  const finish = async () => {
    await Promise.all([refreshTree(), refreshEnvironments(), refreshVariables()]);
    setOpen(false);
    setText("");
    setLink("");
  };

  const importCurl = (cmd: string) => {
    const r = parseCurl(cmd);
    openDraft({
      name: r.url.replace(/^https?:\/\//, "").slice(0, 60),
      method: r.method,
      url: r.url,
      params: paramsFromUrl(r.url),
      headers: r.headers,
      body: r.body,
      auth: r.auth,
      settings: { ...DEFAULT_SETTINGS, verifySsl: !r.insecure },
    });
    toast.success("cURL command opened in a new tab");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await finish();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFiles = (files: FileList | File[]) =>
    run(async () => {
      for (const f of Array.from(files)) {
        const content = await f.text();
        if (/^\s*curl\s/i.test(content)) importCurl(content);
        else await send({ content });
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          <DialogDescription>
            Postman collection (v2.0/v2.1) or environment, OpenAPI 3 / Swagger 2 (JSON or YAML), or a cURL
            command.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="file">
          <TabsList>
            <TabsTrigger value="file">File</TabsTrigger>
            <TabsTrigger value="text">Raw text / cURL</TabsTrigger>
            <TabsTrigger value="link">Link</TabsTrigger>
          </TabsList>
          <TabsContent value="file">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                void importFiles(e.dataTransfer.files);
              }}
              className={`flex h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground ${drag ? "border-primary bg-primary/5" : "hover:border-primary"}`}
            >
              {busy ? <Loader2 className="size-6 animate-spin" /> : <FileUp className="size-6" />}
              <span>Drop files here or click to choose</span>
              <span className="text-xs">.json, .yaml, .yml, .txt (multiple allowed)</span>
              <input
                type="file"
                multiple
                accept=".json,.yaml,.yml,.txt,.sh"
                className="hidden"
                onChange={(e) => e.target.files && importFiles(e.target.files)}
              />
            </label>
          </TabsContent>
          <TabsContent value="text" className="space-y-2">
            <Textarea
              className="h-56 font-mono text-xs"
              placeholder={
                "curl https://api.example.com/users -H 'Accept: application/json'\n\n— or paste Postman / OpenAPI JSON or YAML —"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                disabled={!text.trim() || busy}
                onClick={() =>
                  run(async () => {
                    if (/^\s*curl\s/i.test(text)) importCurl(text);
                    else await send({ content: text });
                  })
                }
              >
                {busy && <Loader2 className="size-4 animate-spin" />} Import
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="link" className="space-y-2">
            <Input
              placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The file is fetched by the Postbox server, so it can reach hosts on your network.
            </p>
            <div className="flex justify-end">
              <Button disabled={!link.trim() || busy} onClick={() => run(() => send({ url: link.trim() }))}>
                {busy && <Loader2 className="size-4 animate-spin" />} Import
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
