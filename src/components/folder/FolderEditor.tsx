"use client";
/**
 * Collection / folder settings tab: description, auth, headers, scripts and
 * (for collections) collection variables. Children inherit these settings.
 */
import { useEffect, useState } from "react";
import { Play, Save } from "lucide-react";
import { toast } from "sonner";
import type { FolderDef, Variable } from "@/core/types";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AuthEditor } from "@/components/request/AuthEditor";
import { KeyValueEditor } from "@/components/request/KeyValueEditor";
import { ScriptEditor } from "@/components/request/ScriptEditor";
import { DocumentationEditor } from "./DocumentationEditor";
import { VariablesEditor } from "@/components/env/VariablesEditor";

type Editable = FolderDef & { parentId: string | null; variables: Variable[] };

export function FolderEditor({ folderId }: { folderId: string }) {
  const refreshTree = useApp((s) => s.refreshTree);
  const refreshVariables = useApp((s) => s.refreshVariables);
  const openTab = useApp((s) => s.openTab);
  const [data, setData] = useState<Editable | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api.folders
      .get(folderId)
      .then((f) => {
        const d: Editable = { ...f, variables: f.variables ?? [] };
        setData(d);
        setSaved(JSON.stringify(d));
      })
      .catch((e) => toast.error(e.message));
  }, [folderId]);

  if (!data) return <div className="p-6 text-muted-foreground">Loading…</div>;
  const isCollection = !data.parentId;
  const dirty = JSON.stringify(data) !== saved;
  const set = (patch: Partial<Editable>) => setData({ ...data, ...patch });

  const save = async () => {
    const { id: _id, parentId: _p, variables, ...patch } = data;
    await api.folders.update(folderId, {
      ...patch,
      ...(isCollection ? { variables: variables.filter((v) => v.key) } : {}),
    });
    setSaved(JSON.stringify(data));
    await refreshTree();
    await refreshVariables();
    toast.success("Saved");
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <input
          className="rounded bg-transparent px-1 text-lg font-medium outline-none hover:bg-accent focus:bg-accent"
          value={data.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
          {isCollection ? "collection" : "folder"}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openTab({ id: `runner-${folderId}`, type: "runner", folderId, name: data.name })}
          >
            <Play className="size-3.5" /> Run
          </Button>
          <Button size="sm" variant={dirty ? "default" : "ghost"} onClick={save}>
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      </div>
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 h-8 justify-start bg-transparent p-0">
          <TabsTrigger value="overview" className="text-xs">
            Overview
          </TabsTrigger>
          <TabsTrigger value="auth" className="text-xs">
            Authorization
          </TabsTrigger>
          <TabsTrigger value="headers" className="text-xs">
            Headers
          </TabsTrigger>
          <TabsTrigger value="pre" className="text-xs">
            Pre-request Script
          </TabsTrigger>
          <TabsTrigger value="test" className="text-xs">
            Post-response Script
          </TabsTrigger>
          {isCollection && (
            <TabsTrigger value="documentation" className="text-xs">
              Documentation
            </TabsTrigger>
          )}
          {isCollection && (
            <TabsTrigger value="variables" className="text-xs">
              Variables
            </TabsTrigger>
          )}
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {isCollection && (
            <TabsContent value="documentation" className="mt-0">
              <DocumentationEditor key={folderId} folderId={folderId} />
            </TabsContent>
          )}
          <TabsContent value="overview" className="mt-0 max-w-3xl">
            <Textarea
              className="min-h-40"
              placeholder="Describe this collection or folder (Markdown)"
              value={data.description ?? ""}
              onChange={(e) => set({ description: e.target.value })}
            />
          </TabsContent>
          <TabsContent value="auth" className="mt-0">
            <p className="mb-3 text-xs text-muted-foreground">
              Requests and folders set to &quot;Inherit auth from parent&quot; use this configuration.
            </p>
            <AuthEditor
              auth={data.auth}
              onChange={(auth) => set({ auth })}
              isCollection={isCollection}
              folderId={folderId}
            />
          </TabsContent>
          <TabsContent value="headers" className="mt-0">
            <p className="mb-2 text-xs text-muted-foreground">
              Sent with every request inside. Request headers with the same name take precedence.
            </p>
            <KeyValueEditor rows={data.headers} onChange={(headers) => set({ headers })} />
          </TabsContent>
          <TabsContent value="pre" className="mt-0 h-full">
            <ScriptEditor
              kind="pre"
              value={data.preRequestScript}
              onChange={(preRequestScript) => set({ preRequestScript })}
            />
          </TabsContent>
          <TabsContent value="test" className="mt-0 h-full">
            <ScriptEditor
              kind="test"
              value={data.testScript}
              onChange={(testScript) => set({ testScript })}
            />
          </TabsContent>
          {isCollection && (
            <TabsContent value="variables" className="mt-0">
              <VariablesEditor variables={data.variables} onChange={(variables) => set({ variables })} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </div>
  );
}
