"use client";
/**
 * Settings page, generated from the settings registry: category navigation,
 * search across every setting, per-setting/section/all reset, import/export,
 * read-only environment settings, and pointers to settings that live elsewhere.
 */
import { useMemo, useRef, useState } from "react";
import {
  Cookie,
  Download,
  Globe,
  Keyboard,
  Library,
  Lock,
  Play,
  RotateCcw,
  Search,
  Server,
  SlidersHorizontal,
  Upload,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import {
  CATEGORIES,
  SETTINGS,
  matchesQuery,
  type SettingCategory,
  type SettingDef,
} from "@/lib/settings/registry";
import { useSettings } from "@/stores/settings";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DataManagement } from "./DataManagement";
import { cn } from "@/lib/utils";
import { SettingControl } from "./SettingControl";
import { UsersSettings } from "./UsersSettings";
import { useIdentity } from "./useIdentity";
import { WorkspaceSharing } from "./WorkspaceSharing";
import { AppearancePreview } from "./AppearancePreview";

type Section = SettingCategory | "environment" | "elsewhere" | "sharing" | "users";

const EXTRA_SECTIONS: { id: Section; label: string; icon: typeof Server }[] = [
  { id: "sharing", label: "Workspace sharing", icon: Globe },
  { id: "environment", label: "Server (environment)", icon: Server },
  { id: "elsewhere", label: "Other settings", icon: Wrench },
];

export function SettingsView() {
  const { values, saved, envLocked, query, setQuery, reset, importFile } = useSettings();
  const identity = useIdentity();
  const [section, setSection] = useState<Section>("appearance");
  const [confirmAll, setConfirmAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const modified = (key: string) => key in saved && !(key in envLocked);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => SETTINGS.filter((d) => matchesQuery(d, query)), [query]);

  const onImport = async (file: File) => {
    try {
      await importFile(JSON.parse(await file.text()));
    } catch (err) {
      toast.error(`Import failed: ${(err as Error).message}`);
    }
  };

  const renderSettings = (defs: SettingDef[]) => (
    <div className="divide-y rounded-lg border">
      {defs.map((def) => (
        <div
          key={def.key}
          id={`setting-${def.key}`}
          className={cn(
            "flex flex-col gap-3 p-4",
            def.type !== "keyvalue" && "md:flex-row md:items-start md:justify-between",
          )}
        >
          <div className="min-w-0 md:max-w-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
              {modified(def.key) && (
                <span className="size-1.5 rounded-full bg-primary" title="Changed from default" />
              )}
              {def.label}
              {envLocked[def.key] && (
                <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                  <Lock className="size-3" /> set via {envLocked[def.key]}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{def.description}</p>
          </div>
          <div
            className={cn("flex items-start gap-2", def.type === "keyvalue" ? "w-full" : "md:justify-end")}
          >
            <SettingControl
              def={def}
              value={values[def.key]}
              disabled={!!envLocked[def.key] || (def.scope === "server" && !identity?.isAdmin)}
            />
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-8 shrink-0 text-muted-foreground", !modified(def.key) && "invisible")}
              title="Reset to default"
              onClick={() => reset([def.key])}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );

  const category = CATEGORIES.find((c) => c.id === section);
  const sectionDefs = SETTINGS.filter((d) => d.category === section);

  return (
    <div className="flex h-full min-h-0">
      <nav className="hidden w-56 shrink-0 flex-col gap-0.5 border-r p-3 text-sm md:flex">
        <div className="mb-2 flex items-center gap-2 px-2 font-semibold">
          <SlidersHorizontal className="size-4 text-primary" /> Settings
        </div>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setSection(c.id);
              setQuery("");
            }}
            className={cn(
              "flex items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-accent",
              !searching && section === c.id && "bg-accent font-medium",
            )}
          >
            {c.label}
            {SETTINGS.some((d) => d.category === c.id && modified(d.key)) && (
              <span className="size-1.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
        <div className="my-2 border-t" />
        {[
          ...EXTRA_SECTIONS,
          ...(identity?.isAdmin ? [{ id: "users" as Section, label: "Users", icon: Globe }] : []),
        ].map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setSection(s.id);
              setQuery("");
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground",
              !searching && section === s.id && "bg-accent font-medium text-foreground",
            )}
          >
            <s.icon className="size-3.5" /> {s.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-6 py-3 backdrop-blur">
          <div className="relative w-full max-w-md">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings (e.g. accent, font, sidebar)"
              className="h-9 pl-8"
            />
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open("/api/settings/import", "_blank")}
              title="Download your settings as JSON"
            >
              <Download className="size-3.5" /> Export
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileRef.current?.click()}
              title="Replace your settings from a JSON file"
            >
              <Upload className="size-3.5" /> Import
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImport(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAll(true)}
              disabled={!Object.keys(saved).length}
            >
              <RotateCcw className="size-3.5" /> Reset all
            </Button>
          </div>
        </div>

        <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
          {searching ? (
            matches.length ? (
              CATEGORIES.filter((c) => matches.some((m) => m.category === c.id)).map((c) => (
                <section key={c.id} className="space-y-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {c.label}
                  </h3>
                  {renderSettings(matches.filter((m) => m.category === c.id))}
                </section>
              ))
            ) : (
              <p className="py-12 text-center text-muted-foreground">
                No settings match &quot;{query}&quot;.
              </p>
            )
          ) : category ? (
            <>
              <header className="flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">{category.label}</h2>
                  <p className="text-sm text-muted-foreground">{category.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!sectionDefs.some((d) => modified(d.key))}
                  onClick={() => reset(sectionDefs.filter((d) => modified(d.key)).map((d) => d.key))}
                >
                  <RotateCcw className="size-3.5" /> Reset section
                </Button>
              </header>
              {section === "appearance" && <AppearancePreview />}
              {renderSettings(sectionDefs)}
              {section === "data" && <DataManagement isAdmin={!!identity?.isAdmin} />}
            </>
          ) : section === "users" && identity?.isAdmin ? (
            <UsersSettings />
          ) : section === "sharing" ? (
            <WorkspaceSharing />
          ) : section === "environment" ? (
            <EnvironmentSection />
          ) : (
            <ElsewhereSection />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Reset all settings?"
        description="Every setting returns to its default. Your collections, environments and history are not affected."
        confirmLabel="Reset all"
        destructive
        onConfirm={() => reset(Object.keys(saved))}
      />
    </div>
  );
}

function EnvironmentSection() {
  const environment = useSettings((s) => s.environment);
  return (
    <>
      <header>
        <h2 className="text-xl font-semibold">Server (environment)</h2>
        <p className="text-sm text-muted-foreground">
          These are set with environment variables in your <code>.env</code> file (Docker) and can&apos;t be
          changed here. Restart the container after editing them. Secret values are never shown.
        </p>
      </header>
      <div className="divide-y rounded-lg border text-sm">
        {environment.map((e) => (
          <div key={e.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <div className="min-w-0">
              <div className="font-mono text-xs">{e.name}</div>
              <div className="text-xs text-muted-foreground">{e.description}</div>
            </div>
            <span
              className={cn(
                "max-w-[50%] truncate font-mono text-xs",
                e.isSet ? "text-foreground" : "text-muted-foreground",
              )}
              title={e.value}
            >
              {e.value}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ElsewhereSection() {
  const { openTab, folders, tabs, activeTabId } = useApp();
  const setShortcutsOpen = useDialogs((s) => s.setShortcutsOpen);
  const firstCollection = folders.find((f) => !f.parentId);
  const requestTab = tabs.find((t) => t.type === "request" && t.id !== activeTabId);

  const items: {
    icon: typeof Server;
    title: string;
    body: string;
    action?: { label: string; run: () => void };
  }[] = [
    {
      icon: SlidersHorizontal,
      title: "Request settings",
      body: "Timeout, redirects, SSL verification and cookie jar for a single request: open a request and use its Settings tab.",
      action: requestTab
        ? { label: "Open a request", run: () => useApp.getState().setActiveTab(requestTab.id) }
        : undefined,
    },
    {
      icon: Library,
      title: "Collection & folder settings",
      body: "Auth, headers, pre-request/post-response scripts and collection variables are inherited by everything inside. Use Edit collection or Edit folder from the sidebar menu.",
      action: firstCollection
        ? {
            label: `Edit "${firstCollection.name}"`,
            run: () =>
              openTab({
                id: `folder-${firstCollection.id}`,
                type: "folder",
                folderId: firstCollection.id,
                name: firstCollection.name,
              }),
          }
        : undefined,
    },
    {
      icon: Globe,
      title: "Environments & globals",
      body: "Variables for each environment and global variables, including secret values.",
      action: {
        label: "Edit globals",
        run: () => openTab({ id: "globals", type: "globals", name: "Globals" }),
      },
    },
    {
      icon: Play,
      title: "Collection runner options",
      body: "Iterations, delay, stop on failure, SSL verification and iteration data are chosen per run in the Runner tab.",
      action: firstCollection
        ? {
            label: "Open runner",
            run: () =>
              openTab({
                id: `runner-${firstCollection.id}`,
                type: "runner",
                folderId: firstCollection.id,
                name: firstCollection.name,
              }),
          }
        : undefined,
    },
    {
      icon: Cookie,
      title: "Cookies",
      body: "The workspace cookie jar used when sending requests.",
      action: {
        label: "Manage cookies",
        run: () => openTab({ id: "cookies", type: "cookies", name: "Cookies" }),
      },
    },
    {
      icon: Keyboard,
      title: "Keyboard shortcuts",
      body: "All shortcuts. Rebinding is planned for a later settings phase.",
      action: { label: "Show shortcuts", run: () => setShortcutsOpen(true) },
    },
  ];

  return (
    <>
      <header>
        <h2 className="text-xl font-semibold">Other settings</h2>
        <p className="text-sm text-muted-foreground">Settings that live next to what they configure.</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((it) => (
          <div key={it.title} className="flex flex-col gap-2 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <it.icon className="size-4 text-primary" /> {it.title}
            </div>
            <p className="flex-1 text-xs text-muted-foreground">{it.body}</p>
            {it.action && (
              <Button variant="outline" size="sm" className="self-start" onClick={it.action.run}>
                {it.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
