"use client";
/**
 * "Save as" dialog for unsaved drafts: pick a name and a target collection/folder.
 */
import { useMemo, useState } from "react";
import { Folder, FolderOpen, Library } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApp } from "@/stores/app";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function SaveRequestDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultName: string;
  onSave: (target: { folderId: string; name: string }) => Promise<void> | void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Mounted only while open so its state resets each time. */}
      {props.open && <SaveRequestForm {...props} />}
    </Dialog>
  );
}

function SaveRequestForm({
  onOpenChange,
  defaultName,
  onSave,
}: {
  onOpenChange: (o: boolean) => void;
  defaultName: string;
  onSave: (target: { folderId: string; name: string }) => Promise<void> | void;
}) {
  const folders = useApp((s) => s.folders);
  const workspaceId = useApp((s) => s.workspaceId);
  const refreshTree = useApp((s) => s.refreshTree);
  const [name, setName] = useState(defaultName);
  const [selected, setSelected] = useState<string | null>(() => folders[0]?.id ?? null);

  const ordered = useMemo(() => {
    const out: { id: string; name: string; depth: number; root: boolean }[] = [];
    const walk = (parent: string | null, depth: number) =>
      folders
        .filter((f) => f.parentId === parent)
        .forEach((f) => {
          out.push({ id: f.id, name: f.name, depth, root: !parent });
          walk(f.id, depth + 1);
        });
    walk(null, 0);
    return out;
  }, [folders]);

  return (
    <>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Request name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>Save to</Label>
            <div className="max-h-64 overflow-auto rounded-md border p-1 text-sm">
              {ordered.length === 0 && (
                <p className="p-3 text-center text-xs text-muted-foreground">No collections yet.</p>
              )}
              {ordered.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent",
                    selected === f.id && "bg-accent",
                  )}
                  style={{ paddingLeft: 8 + f.depth * 16 }}
                  onClick={() => setSelected(f.id)}
                >
                  {f.root ? (
                    <Library className="size-4 text-primary" />
                  ) : selected === f.id ? (
                    <FolderOpen className="size-4" />
                  ) : (
                    <Folder className="size-4" />
                  )}
                  {f.name}
                </button>
              ))}
            </div>
            <Button
              variant="link"
              size="sm"
              className="h-6 px-0 text-xs"
              onClick={async () => {
                if (!workspaceId) return;
                const c = await api.folders.create(workspaceId, null, "New Collection");
                await refreshTree();
                setSelected(c.id);
              }}
            >
              + New collection
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected || !name.trim()}
            onClick={async () => {
              await onSave({ folderId: selected!, name: name.trim() });
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </>
  );
}
