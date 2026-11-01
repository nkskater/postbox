"use client";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Command,
  Cookie,
  Eye,
  Keyboard,
  Moon,
  Plus,
  Settings,
  Sun,
  Upload,
  Mailbox,
  LogOut,
  UserRound,
} from "lucide-react";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { useIdentity } from "@/components/settings/useIdentity";
import { useSettings } from "@/stores/settings";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Header: workspace switcher, environment selector with quick look, global actions. */
export function TopBar({ authEnabled }: { authEnabled: boolean }) {
  const settingsKey = useShortcutLabel("settings");
  const router = useRouter();
  const identity = useIdentity();
  const {
    workspaces,
    workspaceId,
    setWorkspace,
    environments,
    environmentId,
    setEnvironment,
    variables,
    theme,
    openTab,
  } = useApp();
  const { setImportOpen, setPaletteOpen, setShortcutsOpen } = useDialogs();
  const [newWs, setNewWs] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
      <div className="flex items-center gap-2 pr-2 font-semibold">
        <Mailbox className="size-5 text-primary" />
        <span>Postbox</span>
      </div>
      <Select
        value={workspaceId ?? undefined}
        onValueChange={(v) => (v === "__new" ? setNewWs("") : setWorkspace(v))}
      >
        <SelectTrigger size="sm" className="h-7 w-48 text-xs">
          <SelectValue placeholder="Workspace" />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id} className="text-xs">
              {w.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value="__new" className="text-xs">
            <Plus className="size-3" /> New workspace…
          </SelectItem>
        </SelectContent>
      </Select>
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setImportOpen(true)}>
        <Upload className="size-3.5" /> Import
      </Button>

      <button
        className="mx-auto flex h-7 w-80 items-center gap-2 rounded-md border bg-background/50 px-2 text-xs text-muted-foreground hover:bg-accent"
        onClick={() => setPaletteOpen(true)}
      >
        <Command className="size-3.5" /> Search requests and commands…
        <kbd className="ml-auto rounded border px-1 text-[10px]">Ctrl K</kbd>
      </button>

      {identity?.user && (
        <span
          className="flex max-w-48 flex-col text-[10px] leading-tight text-muted-foreground"
          title={identity.user.displayName}
        >
          <span className="truncate">@{identity.user.username}</span>
          <span className="truncate">
            {identity.isAdmin
              ? "administrator"
              : (identity.workspaces.find((ws) => ws.id === workspaceId)?.role ?? "no access")}{" "}
            · {identity.workspaces.find((ws) => ws.id === workspaceId)?.memberCount ?? 0} members
          </span>
        </span>
      )}
      <Select
        value={environmentId ?? "__none"}
        onValueChange={(v) => setEnvironment(v === "__none" ? null : v)}
      >
        <SelectTrigger size="sm" className="h-7 w-48 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none" className="text-xs">
            No environment
          </SelectItem>
          {environments.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-xs">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" title="Environment quick look">
            <Eye className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 text-xs">
          <div className="mb-2 font-medium">Variables in scope</div>
          {Object.keys(variables).length === 0 ? (
            <p className="text-muted-foreground">No variables defined.</p>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full">
                <tbody>
                  {Object.entries(variables).map(([k, v]) => (
                    <tr key={k} className="border-b">
                      <td className="py-1 pr-2 font-mono">{k}</td>
                      <td className="max-w-40 truncate py-1 pr-2 font-mono text-muted-foreground">
                        {v.secret ? "••••••••" : v.value}
                      </td>
                      <td className="py-1 text-[10px] text-muted-foreground">{v.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            {environmentId && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() =>
                  openTab({
                    id: `env-${environmentId}`,
                    type: "environment",
                    environmentId,
                    name: environments.find((e) => e.id === environmentId)?.name ?? "",
                  })
                }
              >
                Edit environment
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => openTab({ id: "globals", type: "globals", name: "Globals" })}
            >
              Edit globals
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Cookies"
        onClick={() => openTab({ id: "cookies", type: "cookies", name: "Cookies" })}
      >
        <Cookie className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Keyboard shortcuts"
        onClick={() => setShortcutsOpen(true)}
      >
        <Keyboard className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title={`Settings (${settingsKey})`}
        onClick={() => openTab({ id: "settings", type: "settings", name: "Settings" })}
      >
        <Settings className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Toggle theme"
        onClick={() =>
          void useSettings.getState().set("appearance.theme", theme === "dark" ? "light" : "dark")
        }
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title={authEnabled ? "Profile and API tokens" : "Set up user accounts"}
        onClick={() => router.push("/profile")}
      >
        <UserRound className="size-4" />
      </Button>
      {authEnabled && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Sign out"
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true);
            try {
              const response = await fetch("/api/auth/logout", { method: "POST" });
              if (!response.ok) throw new Error("Could not sign out. Please try again.");
              router.replace("/login");
              router.refresh();
            } catch {
              toast.error("Could not sign out. Please try again.");
              setSigningOut(false);
            }
          }}
        >
          <LogOut className="size-4" />
        </Button>
      )}

      <Dialog open={newWs !== null} onOpenChange={(o) => !o && setNewWs(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newWs ?? ""}
            onChange={(e) => setNewWs(e.target.value)}
            placeholder="Workspace name"
          />
          <DialogFooter>
            <Button
              disabled={!newWs?.trim()}
              onClick={async () => {
                const ws = await api.workspaces.create(newWs!.trim());
                setNewWs(null);
                useApp.setState({ workspaces: await api.workspaces.list() });
                await setWorkspace(ws.id);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
