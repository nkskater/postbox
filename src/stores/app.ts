"use client";
/**
 * Global client state: active workspace/environment, sidebar tree, open tabs
 * (with unsaved drafts), console output and the variable map used for highlighting.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConsoleEntry, RequestDef, Variable } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import {
  api,
  type EnvironmentSummary,
  type ProxyResult,
  type TreeFolderSummary,
  type TreeRequestSummary,
  type Workspace,
} from "@/lib/api";
import { toast } from "sonner";

export type RequestDraft = RequestDef & { folderId: string | null };

export type Tab =
  | {
      id: string;
      type: "request";
      requestId: string | null;
      draft: RequestDraft;
      /** JSON snapshot of the last saved state, for dirty detection. */
      saved: string | null;
      result?: ProxyResult | null;
      sending?: boolean;
      /** Transient tab (single click preview); replaced by the next preview. */
      preview?: boolean;
    }
  | { id: string; type: "folder"; folderId: string; name: string }
  | { id: string; type: "environment"; environmentId: string; name: string }
  | { id: string; type: "globals"; name: string }
  | { id: string; type: "runner"; folderId: string; name: string }
  | { id: string; type: "cookies"; name: string };

export interface KnownVariable {
  value: string;
  scope: "global" | "collection" | "environment";
  secret: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function newDraft(partial: Partial<RequestDraft> = {}): RequestDraft {
  return {
    id: `draft-${uid()}`,
    name: "Untitled Request",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none" },
    auth: { type: "inherit" },
    preRequestScript: "",
    testScript: "",
    settings: { ...DEFAULT_SETTINGS },
    description: "",
    examples: [],
    folderId: null,
    ...partial,
  };
}

/** Fields compared for dirty detection / persisted on save. */
export function snapshot(d: RequestDraft): string {
  const { id: _id, examples: _e, ...rest } = d;
  return JSON.stringify(rest);
}

const abortControllers = new Map<string, AbortController>();
/** In-flight openRequest calls, so rapid clicks don't open duplicate tabs. */
const opening = new Map<string, Promise<void>>();

interface AppState {
  workspaces: Workspace[];
  workspaceId: string | null;
  environments: EnvironmentSummary[];
  environmentId: string | null;
  folders: TreeFolderSummary[];
  requests: TreeRequestSummary[];
  tabs: Tab[];
  activeTabId: string | null;
  consoleEntries: ConsoleEntry[];
  consoleOpen: boolean;
  /** variable name -> value for highlighting in the active context */
  variables: Record<string, KnownVariable>;
  theme: "dark" | "light";
  sidebarView: "collections" | "environments" | "history";
  historyVersion: number;

  init(): Promise<void>;
  setWorkspace(id: string): Promise<void>;
  refreshTree(): Promise<void>;
  refreshEnvironments(): Promise<void>;
  setEnvironment(id: string | null): void;
  refreshVariables(): Promise<void>;

  openRequest(id: string, opts?: { preview?: boolean }): Promise<void>;
  openDraft(partial?: Partial<RequestDraft>, result?: ProxyResult | null): void;
  openTab(tab: Tab): void;
  closeTab(id: string): void;
  closeOtherTabs(id: string): void;
  setActiveTab(id: string): void;
  updateDraft(tabId: string, patch: Partial<RequestDraft>): void;
  saveTab(tabId: string, target?: { folderId: string; name: string }): Promise<boolean>;
  sendTab(tabId: string): Promise<void>;
  cancelSend(tabId: string): void;
  onRequestRenamed(id: string, name: string): void;
  onEntityDeleted(kind: "folder" | "request" | "environment", id: string): void;

  log(entries: ConsoleEntry[]): void;
  clearConsole(): void;
  setConsoleOpen(open: boolean): void;
  setTheme(t: "dark" | "light"): void;
  setSidebarView(v: AppState["sidebarView"]): void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      workspaceId: null,
      environments: [],
      environmentId: null,
      folders: [],
      requests: [],
      tabs: [],
      activeTabId: null,
      consoleEntries: [],
      consoleOpen: false,
      variables: {},
      theme: "dark",
      sidebarView: "collections",
      historyVersion: 0,

      async init() {
        const workspaces = await api.workspaces.list();
        const current = get().workspaceId;
        const ws = workspaces.find((w) => w.id === current) ?? workspaces[0];
        set({ workspaces });
        if (ws) await get().setWorkspace(ws.id);
      },

      async setWorkspace(id) {
        const switching = get().workspaceId !== id;
        set({ workspaceId: id, ...(switching ? { tabs: [], activeTabId: null, environmentId: null } : {}) });
        await Promise.all([get().refreshTree(), get().refreshEnvironments()]);
        const envs = get().environments;
        if (get().environmentId && !envs.some((e) => e.id === get().environmentId))
          set({ environmentId: null });
        // Drop tabs whose entities no longer exist.
        const { folders, requests } = get();
        set((s) => ({
          tabs: s.tabs.filter((t) => {
            if (t.type === "request") return !t.requestId || requests.some((r) => r.id === t.requestId);
            if (t.type === "folder" || t.type === "runner") return folders.some((f) => f.id === t.folderId);
            if (t.type === "environment") return envs.some((e) => e.id === t.environmentId);
            return true;
          }),
        }));
        await get().refreshVariables();
      },

      async refreshTree() {
        const id = get().workspaceId;
        if (!id) return;
        const tree = await api.workspaces.tree(id);
        set({ folders: tree.folders, requests: tree.requests });
      },

      async refreshEnvironments() {
        const id = get().workspaceId;
        if (!id) return;
        set({ environments: await api.environments.list(id) });
      },

      setEnvironment(id) {
        set({ environmentId: id });
        void get().refreshVariables();
      },

      async refreshVariables() {
        const { workspaceId, environmentId } = get();
        if (!workspaceId) return;
        const tab = get().tabs.find((t) => t.id === get().activeTabId);
        let collectionId: string | null = null;
        const folderId =
          tab?.type === "request"
            ? tab.draft.folderId
            : tab?.type === "folder" || tab?.type === "runner"
              ? tab.folderId
              : null;
        if (folderId) {
          const byId = new Map(get().folders.map((f) => [f.id, f]));
          let cur = byId.get(folderId);
          while (cur?.parentId) cur = byId.get(cur.parentId);
          collectionId = cur?.id ?? null;
        }
        const [globals, env, col] = await Promise.all([
          api.variables.list(workspaceId, "global"),
          environmentId
            ? api.variables.list(workspaceId, "environment", environmentId)
            : Promise.resolve([] as Variable[]),
          collectionId
            ? api.variables.list(workspaceId, "collection", collectionId)
            : Promise.resolve([] as Variable[]),
        ]);
        const vars: Record<string, KnownVariable> = {};
        const add = (list: Variable[], scope: KnownVariable["scope"]) =>
          list
            .filter((v) => v.enabled && v.key)
            .forEach((v) => (vars[v.key] = { value: v.value, scope, secret: v.type === "secret" }));
        add(globals, "global");
        add(col, "collection");
        add(env, "environment");
        set({ variables: vars });
      },

      async openRequest(id, opts) {
        const existing = get().tabs.find((t) => t.type === "request" && t.requestId === id);
        if (existing) {
          set((s) => ({
            activeTabId: existing.id,
            tabs: opts?.preview
              ? s.tabs
              : s.tabs.map((t) =>
                  t.id === existing.id && t.type === "request" ? { ...t, preview: false } : t,
                ),
          }));
          void get().refreshVariables();
          return;
        }
        if (opening.has(id)) {
          await opening.get(id);
          if (!opts?.preview) await get().openRequest(id, opts);
          return;
        }
        let done!: () => void;
        opening.set(id, new Promise<void>((r) => (done = r)));
        let r;
        try {
          r = await api.requests.get(id);
        } finally {
          opening.delete(id);
          done();
        }
        const draft: RequestDraft = { ...r, folderId: r.folderId };
        const tab: Tab = {
          id: uid(),
          type: "request",
          requestId: id,
          draft,
          saved: snapshot(draft),
          preview: !!opts?.preview,
        };
        set((s) => {
          // Replace an unmodified preview tab instead of piling up tabs.
          const idx = s.tabs.findIndex(
            (t) => t.type === "request" && t.preview && t.saved === snapshot(t.draft),
          );
          const tabs = s.tabs.slice();
          if (opts?.preview && idx >= 0) tabs[idx] = tab;
          else tabs.push(tab);
          return { tabs, activeTabId: tab.id };
        });
        void get().refreshVariables();
      },

      openDraft(partial, result) {
        const draft = newDraft(partial);
        const tab: Tab = {
          id: uid(),
          type: "request",
          requestId: null,
          draft,
          saved: null,
          result: result ?? null,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      openTab(tab) {
        const same = get().tabs.find(
          (t) =>
            t.type === tab.type &&
            ((t.type === "folder" && tab.type === "folder" && t.folderId === tab.folderId) ||
              (t.type === "runner" && tab.type === "runner" && t.folderId === tab.folderId) ||
              (t.type === "environment" &&
                tab.type === "environment" &&
                t.environmentId === tab.environmentId) ||
              t.type === "globals" ||
              t.type === "cookies"),
        );
        if (same) set({ activeTabId: same.id });
        else set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        void get().refreshVariables();
      },

      closeTab(id) {
        abortControllers.get(id)?.abort();
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          return { tabs, activeTabId };
        });
      },

      closeOtherTabs(id) {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeTabId: id }));
      },

      setActiveTab(id) {
        set({ activeTabId: id });
        void get().refreshVariables();
      },

      updateDraft(tabId, patch) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId && t.type === "request"
              ? { ...t, preview: false, draft: { ...t.draft, ...patch } }
              : t,
          ),
        }));
      },

      async saveTab(tabId, target) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.type !== "request") return false;
        const { workspaceId } = get();
        if (!workspaceId) return false;
        const { id: _id, folderId: _f, ...def } = tab.draft;
        try {
          if (tab.requestId) {
            const saved = await api.requests.update(tab.requestId, def);
            const draft: RequestDraft = { ...saved, folderId: saved.folderId };
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId && t.type === "request" ? { ...t, draft, saved: snapshot(draft) } : t,
              ),
            }));
          } else {
            if (!target) return false;
            const saved = await api.requests.create(workspaceId, target.folderId, {
              ...def,
              name: target.name,
            });
            const draft: RequestDraft = { ...saved, folderId: saved.folderId };
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId && t.type === "request"
                  ? { ...t, requestId: saved.id, draft, saved: snapshot(draft) }
                  : t,
              ),
            }));
          }
          await get().refreshTree();
          toast.success("Saved");
          return true;
        } catch (err) {
          toast.error(`Save failed: ${(err as Error).message}`);
          return false;
        }
      },

      async sendTab(tabId) {
        const tab = get().tabs.find((t) => t.id === tabId);
        const { workspaceId, environmentId } = get();
        if (!tab || tab.type !== "request" || !workspaceId) return;
        if (!tab.draft.url.trim()) {
          toast.error("Enter a URL first");
          return;
        }
        abortControllers.get(tabId)?.abort();
        const ctrl = new AbortController();
        abortControllers.set(tabId, ctrl);
        const patchTab = (p: Partial<Extract<Tab, { type: "request" }>>) =>
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId && t.type === "request" ? { ...t, ...p } : t)),
          }));
        patchTab({ sending: true });
        try {
          const { folderId, ...request } = tab.draft;
          const result = await api.proxy(
            {
              workspaceId,
              environmentId,
              folderId,
              requestId: tab.requestId,
              request: request as RequestDef,
            },
            ctrl.signal,
          );
          patchTab({ sending: false, result });
          get().log(result.logs);
          result.scriptErrors.forEach((e) =>
            get().log([{ level: "error", source: e.source, message: e.message, timestamp: Date.now() }]),
          );
          result.warnings.forEach((w) => toast.warning(w));
          set((s) => ({ historyVersion: s.historyVersion + 1 }));
          void get().refreshVariables();
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            patchTab({ sending: false });
            return;
          }
          patchTab({ sending: false });
          toast.error((err as Error).message);
        } finally {
          if (abortControllers.get(tabId) === ctrl) abortControllers.delete(tabId);
        }
      },

      cancelSend(tabId) {
        abortControllers.get(tabId)?.abort();
      },

      onRequestRenamed(id, name) {
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.type !== "request" || t.requestId !== id) return t;
            const draft = { ...t.draft, name };
            const saved = t.saved ? JSON.stringify({ ...JSON.parse(t.saved), name }) : t.saved;
            return { ...t, draft, saved };
          }),
        }));
      },

      onEntityDeleted(kind, id) {
        set((s) => {
          const tabs = s.tabs.filter((t) => {
            if (kind === "request") return !(t.type === "request" && t.requestId === id);
            if (kind === "environment") return !(t.type === "environment" && t.environmentId === id);
            return !((t.type === "folder" || t.type === "runner") && t.folderId === id);
          });
          return {
            tabs,
            activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs.at(-1)?.id ?? null),
          };
        });
        if (kind === "environment" && get().environmentId === id) get().setEnvironment(null);
      },

      log(entries) {
        if (!entries.length) return;
        set((s) => ({ consoleEntries: [...s.consoleEntries, ...entries].slice(-2000) }));
      },
      clearConsole: () => set({ consoleEntries: [] }),
      setConsoleOpen: (open) => set({ consoleOpen: open }),
      setTheme(theme) {
        document.documentElement.classList.toggle("light", theme === "light");
        set({ theme });
      },
      setSidebarView: (sidebarView) => set({ sidebarView }),
    }),
    {
      name: "postbox-ui",
      version: 1,
      // Persist UI state and unsaved drafts, but not responses or server data.
      partialize: (s) => ({
        workspaceId: s.workspaceId,
        environmentId: s.environmentId,
        theme: s.theme,
        sidebarView: s.sidebarView,
        consoleOpen: s.consoleOpen,
        activeTabId: s.activeTabId,
        tabs: s.tabs.map((t) => (t.type === "request" ? { ...t, result: null, sending: false } : t)),
      }),
    },
  ),
);

/** Folder breadcrumbs for a folder id, collection first. */
export function folderPath(folders: TreeFolderSummary[], folderId: string | null): TreeFolderSummary[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: TreeFolderSummary[] = [];
  let cur = folderId ? byId.get(folderId) : undefined;
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
