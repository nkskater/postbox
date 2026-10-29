"use client";
/**
 * Tab for editing an environment's or the global variables.
 */
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import type { Variable } from "@/core/types";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { VariablesEditor } from "./VariablesEditor";

export function EnvironmentEditor({ environmentId }: { environmentId: string | null }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const refreshEnvironments = useApp((s) => s.refreshEnvironments);
  const refreshVariables = useApp((s) => s.refreshVariables);
  const variablesVersion = useApp((s) => s.variables);
  const [name, setName] = useState("");
  const [vars, setVars] = useState<Variable[]>([]);
  const [saved, setSaved] = useState("[]");
  const [loaded, setLoaded] = useState(false);

  const dirty = JSON.stringify(vars) !== saved;

  // Reload when scripts changed variables (unless the user has unsaved edits).
  useEffect(() => {
    if (!workspaceId || (loaded && dirty)) return;
    (async () => {
      if (environmentId) {
        const env = await api.environments.get(environmentId);
        setName(env.name);
        setVars(env.variables);
        setSaved(JSON.stringify(env.variables));
      } else {
        const list = await api.variables.list(workspaceId, "global");
        setName("Globals");
        setVars(list);
        setSaved(JSON.stringify(list));
      }
      setLoaded(true);
    })().catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, workspaceId, variablesVersion]);

  const save = async () => {
    if (!workspaceId) return;
    const clean = vars.filter((v) => v.key);
    if (environmentId) await api.environments.update(environmentId, { name, variables: clean });
    else await api.variables.replace(workspaceId, "global", null, clean);
    setSaved(JSON.stringify(clean));
    setVars(clean);
    await refreshEnvironments();
    await refreshVariables();
    toast.success("Saved");
  };

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-auto p-4"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <div className="flex items-center gap-2">
        {environmentId ? (
          <input
            className="rounded bg-transparent px-1 text-lg font-medium outline-none hover:bg-accent focus:bg-accent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <h2 className="text-lg font-medium">Globals</h2>
        )}
        <Button size="sm" variant={dirty ? "default" : "ghost"} className="ml-auto" onClick={save}>
          <Save className="size-3.5" /> Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {environmentId
          ? "Environment variables override collection and global variables. Secret values are masked and never logged."
          : "Global variables are available in every collection and environment of this workspace (lowest precedence)."}
      </p>
      <VariablesEditor variables={vars} onChange={setVars} />
    </div>
  );
}
