"use client";
/**
 * Ctrl+K command palette: jump to requests, collections and environments, or run commands.
 */
import {
  Palette,
  Settings,
  FilePlus,
  Globe,
  Keyboard,
  Layers,
  Library,
  Moon,
  Play,
  Terminal,
  Upload,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useApp, folderPath } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { useSettings } from "@/stores/settings";
import { ACCENT_PRESETS } from "@/lib/settings/accent";
import { CATEGORIES, SETTINGS } from "@/lib/settings/registry";
import { methodColor } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CommandPalette() {
  const open = useDialogs((s) => s.paletteOpen);
  const setOpen = useDialogs((s) => s.setPaletteOpen);
  const { setImportOpen, setShortcutsOpen } = useDialogs();
  const {
    requests,
    folders,
    environments,
    openRequest,
    openTab,
    openDraft,
    setEnvironment,
    theme,
    setConsoleOpen,
    consoleOpen,
  } = useApp();

  const openSettings = (query: string) => {
    useSettings.getState().setQuery(query);
    openTab({ id: "settings", type: "settings", name: "Settings" });
  };

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search requests and commands"
    >
      <CommandInput placeholder="Type a request name or command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Commands">
          <CommandItem onSelect={() => run(() => openDraft())}>
            <FilePlus /> New request
          </CommandItem>
          <CommandItem onSelect={() => run(() => setImportOpen(true))}>
            <Upload /> Import collection, environment, cURL or OpenAPI
          </CommandItem>
          <CommandItem
            onSelect={() => run(() => openTab({ id: "globals", type: "globals", name: "Globals" }))}
          >
            <Globe /> Edit globals
          </CommandItem>
          <CommandItem onSelect={() => run(() => setConsoleOpen(!consoleOpen))}>
            <Terminal /> Toggle console
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(
                () =>
                  void useSettings.getState().set("appearance.theme", theme === "dark" ? "light" : "dark"),
              )
            }
          >
            <Moon /> Toggle theme
          </CommandItem>
          <CommandItem onSelect={() => run(() => setShortcutsOpen(true))}>
            <Keyboard /> Keyboard shortcuts
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => run(() => openSettings(""))}>
            <Settings /> Open settings
          </CommandItem>
          {SETTINGS.map((d) => (
            <CommandItem
              key={d.key}
              value={`settings ${d.label} ${d.description} ${(d.keywords ?? []).join(" ")}`}
              onSelect={() => run(() => openSettings(d.label))}
            >
              <Settings /> Settings: {d.label}
              <span className="ml-auto text-xs text-muted-foreground">
                {CATEGORIES.find((c) => c.id === d.category)?.label}
              </span>
            </CommandItem>
          ))}
          {ACCENT_PRESETS.map((p) => (
            <CommandItem
              key={p.id}
              value={`accent color ${p.label}`}
              onSelect={() => run(() => void useSettings.getState().set("appearance.accent", p.id))}
            >
              <Palette /> Accent color: {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Requests">
          {requests.map((r) => (
            <CommandItem
              key={r.id}
              value={`${r.method} ${r.name} ${folderPath(folders, r.folderId)
                .map((f) => f.name)
                .join(" ")} ${r.id}`}
              onSelect={() => run(() => void openRequest(r.id))}
            >
              <span className={cn("w-12 font-mono text-[10px] font-bold", methodColor(r.method))}>
                {r.method}
              </span>
              <span>{r.name}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {folderPath(folders, r.folderId)
                  .map((f) => f.name)
                  .join(" / ")}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Collections & folders">
          {folders.map((f) => (
            <CommandItem
              key={f.id}
              value={`folder ${f.name} ${f.id}`}
              onSelect={() =>
                run(() => openTab({ id: `folder-${f.id}`, type: "folder", folderId: f.id, name: f.name }))
              }
            >
              <Library /> {f.name}
            </CommandItem>
          ))}
          {folders.map((f) => (
            <CommandItem
              key={`run-${f.id}`}
              value={`run ${f.name} ${f.id}`}
              onSelect={() =>
                run(() => openTab({ id: `runner-${f.id}`, type: "runner", folderId: f.id, name: f.name }))
              }
            >
              <Play /> Run {f.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Environments">
          {environments.map((e) => (
            <CommandItem
              key={e.id}
              value={`env ${e.name} ${e.id}`}
              onSelect={() => run(() => setEnvironment(e.id))}
            >
              <Layers /> Use environment: {e.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
