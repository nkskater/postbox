"use client";
import { useState } from "react";
import { Check, Copy, Globe, Layers, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/stores/app";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { cn } from "@/lib/utils";

/** Sidebar list of environments plus the Globals entry. */
export function EnvironmentList() {
  const {
    environments,
    environmentId,
    workspaceId,
    setEnvironment,
    openTab,
    refreshEnvironments,
    onEntityDeleted,
  } = useApp();
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);

  const create = async () => {
    if (!workspaceId) return;
    const env = await api.environments.create(workspaceId, "New Environment");
    await refreshEnvironments();
    openTab({ id: `env-${env.id}`, type: "environment", environmentId: env.id, name: env.name });
  };

  return (
    <div className="flex h-full flex-col text-[13px]">
      <div className="flex items-center justify-between p-2">
        <span className="px-1 text-xs font-medium text-muted-foreground">ENVIRONMENTS</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={create} title="New environment">
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto px-1">
        <button
          className="flex h-7 w-full items-center gap-2 rounded px-2 hover:bg-accent"
          onClick={() => openTab({ id: "globals", type: "globals", name: "Globals" })}
        >
          <Globe className="size-4 text-muted-foreground" /> Globals
        </button>
        <div className="my-1 border-t" />
        {environments.map((e) => (
          <div
            key={e.id}
            className="group flex h-7 cursor-pointer items-center gap-2 rounded px-2 hover:bg-accent"
            onClick={() =>
              openTab({ id: `env-${e.id}`, type: "environment", environmentId: e.id, name: e.name })
            }
          >
            <Layers className="size-4 text-muted-foreground" />
            <span className="truncate">{e.name}</span>
            <button
              title={environmentId === e.id ? "Active" : "Set active"}
              className={cn(
                "ml-auto rounded p-0.5",
                environmentId === e.id
                  ? "text-success"
                  : "text-muted-foreground opacity-0 group-hover:opacity-100",
              )}
              onClick={(ev) => {
                ev.stopPropagation();
                setEnvironment(environmentId === e.id ? null : e.id);
              }}
            >
              <Check className="size-3.5" />
            </button>
            <div onClick={(ev) => ev.stopPropagation()} className="opacity-0 group-hover:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6">
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onClick={async () => {
                      await api.environments.duplicate(e.id);
                      await refreshEnvironments();
                    }}
                  >
                    <Copy /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.open(`/api/export/environment/${e.id}`, "_blank")}>
                    Export
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirm({ id: e.id, name: e.name })}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
        {environments.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">
            Environments hold sets of variables (e.g. dev, staging, prod). Create one to get started.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete environment "${confirm?.name}"?`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!confirm) return;
          await api.environments.remove(confirm.id);
          onEntityDeleted("environment", confirm.id);
          await refreshEnvironments();
          toast.success("Environment deleted");
        }}
      />
    </div>
  );
}
