"use client";
/**
 * Global client state: active workspace/environment, sidebar tree, open tabs
 * (with unsaved drafts), console output and the variable map used for highlighting.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConsoleEntry, RequestDef, ExampleRequest, ResponseExample, Variable } from "@/core/types";
import { exampleRequest } from "@/core/examples";
import { DEFAULT_SETTINGS, type RequestSettings } from "@/core/types";
import { getSetting } from "@/lib/settings/runtime";
import { useDialogs } from "./dialogs";
import {
  api,
  type EnvironmentSummary,
  type ProxyResult,
  type TreeFolderSummary,
  type TreeRequestSummary,
  type Workspace,
} from "@/lib/api";
import { toast } from "sonner";
import {
  authCredentialValues,
  hasMissingUpload,
  restoreMissingCredentials,
  restoreMissingUploadBytes,
  sanitizeRequestDraftForBrowser,
} from "@/core/retention";

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
      sentTemplate?: ExampleRequest | null;
      sending?: boolean;
      /** Transient tab (single click preview); replaced by the next preview. */
      preview?: boolean;
      /** Secrets were removed from browser storage; restored from the saved request after hydration. */
      credentialsOmitted?: boolean;
    }
  | { id: string; type: "folder"; folderId: string; name: string }
  | { id: string; type: "environment"; environmentId: string; name: string }
  | { id: string; type: "globals"; name: string }
  | { id: string; type: "runner"; folderId: string; name: string }
  | { id: string; type: "cookies"; name: string }
  | { id: string; type: "settings"; name: string };

export interface KnownVariable {
  value: string;
  scope: "global" | "collection" | "environment";
  secret: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Request settings for new requests, from the user's Requests settings. */
export function defaultRequestSettings(): RequestSettings {
  return {
    ...DEFAULT_SETTINGS,
    timeoutMs: getSetting<number>("requests.timeoutMs") ?? DEFAULT_SETTINGS.timeoutMs,
    followRedirects: getSetting<boolean>("requests.followRedirects") ?? DEFAULT_SETTINGS.followRedirects,
    maxRedirects: getSetting<number>("requests.maxRedirects") ?? DEFAULT_SETTINGS.maxRedirects,
    verifySsl: getSetting<boolean>("requests.verifySsl") ?? DEFAULT_SETTINGS.verifySsl,
    useCookieJar: getSetting<boolean>("requests.useCookieJar") ?? DEFAULT_SETTINGS.useCookieJar,
  };
}

export function newDraft(partial: Partial<RequestDraft> = {}): RequestDraft {
  return {
    id: `draft-${uid()}`,
    name: "Untitled Request",
    method: getSetting<string>("requests.defaultMethod") || "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none" },
    auth: { type: "inherit" },
    preRequestScript: "",
    testScript: "",
    settings: defaultRequestSettings(),
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
const saving = new Set<string>();
let workspaceGeneration = 0;
let treeGeneration = 0;
let environmentGeneration = 0;
let variableGeneration = 0;

function abortTab(id: string) {
  abortControllers.get(id)?.abort();
  abortControllers.delete(id);
}

function sanitizeStoredTab(tab: Tab): Tab {
  if (tab.type !== "request") return tab;
  const draft = sanitizeRequestDraftForBrowser(tab.draft);
  let saved = tab.saved;
  if (saved) {
    try {
      saved = JSON.stringify(sanitizeRequestDraftForBrowser(JSON.parse(saved)));
    } catch {
      saved = null;
    }
  }
  return {
    ...tab,
    draft,
    saved,
    result: null,
    sentTemplate: null,
    sending: false,
    credentialsOmitted:
      tab.credentialsOmitted || authCredentialValues(tab.draft.auth).length > 0 || undefined,
  };
}

export function sanitizeStoredState(value: unknown): {
  workspaceId: string | null;
  environmentId: string | null;
  theme: "dark" | "light";
  sidebarView: AppState["sidebarView"];
  consoleOpen: boolean;
  activeTabId: string | null;
  tabs: Tab[];
} {
  if (!value || typeof value !== "object")
    return {
      workspaceId: null,
      environmentId: null,
      theme: "dark",
      sidebarView: "collections",
      consoleOpen: false,
      activeTabId: null,
      tabs: [],
    };
  const state = value as Partial<AppState>;
  return {
    workspaceId: state.workspaceId ?? null,
    environmentId: state.environmentId ?? null,
    theme: state.theme === "light" ? "light" : "dark",
    sidebarView: state.sidebarView ?? "collections",
    consoleOpen: state.consoleOpen ?? false,
    activeTabId: state.activeTabId ?? null,
    tabs: Array.isArray(state.tabs) ? state.tabs.map(sanitizeStoredTab) : [],
  };
}

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
  /** Close a tab, asking for confirmation first if it has unsaved changes (per settings). */
  requestCloseTab(id: string): void;
  closeOtherTabs(id: string): void;
  setActiveTab(id: string): void;
  updateDraft(tabId: string, patch: Partial<RequestDraft>): void;
  saveTab(tabId: string, target?: { folderId: string; name: string }): Promise<boolean>;
  sendTab(tabId: string): Promise<void>;
  cancelSend(tabId: string): void;
  onExamplesChanged(requestId: string, examples: ResponseExample[]): void;
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
        if (ws) {
          await get().setWorkspace(ws.id);
          const pending = get().tabs.filter(
            (tab): tab is Extract<Tab, { type: "request" }> =>
              tab.type === "request" &&
              !!tab.requestId &&
              (!!tab.credentialsOmitted || hasMissingUpload(tab.draft.body)),
          );
          await Promise.all(
            pending.map(async (tab) => {
              try {
                const saved = await api.requests.get(tab.requestId!);
                const savedDraft: RequestDraft = { ...saved, folderId: saved.folderId };
                set((state) => ({
                  tabs: state.tabs.map((current) => {
                    if (current.type !== "request" || current.id !== tab.id || current.requestId !== saved.id)
                      return current;
                    return {
                      ...current,
                      draft: {
                        ...current.draft,
                        auth: current.credentialsOmitted
                          ? restoreMissingCredentials(current.draft.auth, saved.auth)
                          : current.draft.auth,
                        body: hasMissingUpload(current.draft.body)
                          ? restoreMissingUploadBytes(current.draft.body, saved.body)
                          : current.draft.body,
                      },
                      saved: snapshot(savedDraft),
                      credentialsOmitted: false,
                    };
                  }),
                }));
              } catch {
                // Leave omission markers in place so a later save cannot erase the server copy.
              }
            }),
          );
        }
      },

      async setWorkspace(id) {
        const switching = get().workspaceId !== id;
        const generation = switching ? ++workspaceGeneration : workspaceGeneration;
        if (switching) for (const tabId of abortControllers.keys()) abortTab(tabId);
        set({
          workspaceId: id,
          ...(switching
            ? {
                tabs: [],
                activeTabId: null,
                environmentId: null,
                folders: [],
                requests: [],
                environments: [],
                variables: {},
              }
            : {}),
        });
        await Promise.all([get().refreshTree(), get().refreshEnvironments()]);
        if (generation !== workspaceGeneration) return;
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
        const generation = ++treeGeneration;
        const workspace = workspaceGeneration;
        const id = get().workspaceId;
        if (!id) return;
        const tree = await api.workspaces.tree(id);
        if (generation !== treeGeneration || workspace !== workspaceGeneration) return;
        set({ folders: tree.folders, requests: tree.requests });
      },

      async refreshEnvironments() {
        const generation = ++environmentGeneration;
        const workspace = workspaceGeneration;
        const id = get().workspaceId;
        if (!id) return;
        const environments = await api.environments.list(id);
        if (generation !== environmentGeneration || workspace !== workspaceGeneration) return;
        set({ environments });
      },

      setEnvironment(id) {
        set({ environmentId: id });
        void get().refreshVariables();
      },

      async refreshVariables() {
        const generation = ++variableGeneration;
        const workspace = workspaceGeneration;
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
        if (generation !== variableGeneration || workspace !== workspaceGeneration) return;
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
        const workspace = workspaceGeneration;
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
          if (workspace !== workspaceGeneration) return;
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
        if (workspace !== workspaceGeneration) return;
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
        void get().refreshVariables();
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
              t.type === "cookies" ||
              t.type === "settings"),
        );
        if (same) set({ activeTabId: same.id });
        else set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        void get().refreshVariables();
      },

      requestCloseTab(id) {
        const tab = get().tabs.find((t) => t.id === id);
        if (tab && isTabDirty(tab) && getSetting<boolean>("tabs.confirmCloseUnsaved")) {
          useDialogs.getState().setConfirmCloseTabId(id);
        } else get().closeTab(id);
      },

      closeTab(id) {
        abortTab(id);
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          return { tabs, activeTabId };
        });
        void get().refreshVariables();
      },

      closeOtherTabs(id) {
        for (const tab of get().tabs) if (tab.id !== id) abortTab(tab.id);
        set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeTabId: id }));
        void get().refreshVariables();
      },

      setActiveTab(id) {
        set({ activeTabId: id });
        void get().refreshVariables();
      },

      updateDraft(tabId, patch) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId && t.type === "request"
              ? {
                  ...t,
                  ...(patch.auth !== undefined ? { credentialsOmitted: false } : {}),
                  preview: false,
                  draft: { ...t.draft, ...patch },
                }
              : t,
          ),
        }));
      },

      async saveTab(tabId, target) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.type !== "request") return false;
        if (tab.credentialsOmitted || hasMissingUpload(tab.draft.body)) {
          toast.error("Restore saved credentials and files, or re-enter them, before saving this request");
          return false;
        }
        const { workspaceId } = get();
        if (!workspaceId) return false;
        if (saving.has(tabId)) return false;
        saving.add(tabId);
        const workspace = workspaceGeneration;
        const { id: _id, folderId: _f, ...def } = tab.draft;
        try {
          if (tab.requestId) {
            const { examples: _examples, ...requestFields } = def;
            const saved = await api.requests.update(tab.requestId, requestFields);
            const draft: RequestDraft = { ...saved, folderId: saved.folderId };
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId && t.type === "request" && workspace === workspaceGeneration
                  ? {
                      ...t,
                      draft: t.draft === tab.draft ? draft : t.draft,
                      saved: snapshot(draft),
                      credentialsOmitted: false,
                    }
                  : t,
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
                t.id === tabId && t.type === "request" && workspace === workspaceGeneration
                  ? {
                      ...t,
                      requestId: saved.id,
                      credentialsOmitted: false,
                      draft:
                        t.draft === tab.draft
                          ? draft
                          : {
                              ...t.draft,
                              id: saved.id,
                              folderId: saved.folderId,
                              name: t.draft.name === tab.draft.name ? saved.name : t.draft.name,
                            },
                      saved: snapshot(draft),
                    }
                  : t,
              ),
            }));
          }
          if (workspace !== workspaceGeneration) return true;
          await get().refreshTree();
          toast.success("Saved");
          return true;
        } catch (err) {
          toast.error(`Save failed: ${(err as Error).message}`);
          return false;
        } finally {
          saving.delete(tabId);
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
        const workspace = workspaceGeneration;
        abortControllers.set(tabId, ctrl);
        const isCurrent = () => abortControllers.get(tabId) === ctrl && workspace === workspaceGeneration;
        const patchTab = (p: Partial<Extract<Tab, { type: "request" }>>) =>
          set((s) => ({
            tabs: s.tabs.map((t) =>
              isCurrent() && t.id === tabId && t.type === "request" ? { ...t, ...p } : t,
            ),
          }));
        patchTab({ sending: true });
        try {
          const { folderId, ...draftRequest } = tab.draft;
          const request = getSetting<boolean>("requests.trimUrl")
            ? { ...draftRequest, url: draftRequest.url.trim() }
            : draftRequest;
          const sentTemplate = structuredClone(exampleRequest(request));
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
          if (!isCurrent()) return;
          if (ctrl.signal.aborted) {
            patchTab({ sending: false });
            return;
          }
          patchTab({ sending: false, result, sentTemplate });
          get().log(result.logs);
          result.scriptErrors.forEach((e) =>
            get().log([{ level: "error", source: e.source, message: e.message, timestamp: Date.now() }]),
          );
          result.warnings.forEach((w) => toast.warning(w));
          set((s) => ({ historyVersion: s.historyVersion + 1 }));
          void get().refreshVariables();
        } catch (err) {
          if (!isCurrent()) return;
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

      onExamplesChanged(requestId, examples) {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.type === "request" && tab.requestId === requestId
              ? { ...tab, draft: { ...tab.draft, examples } }
              : tab,
          ),
        }));
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
        for (const tab of get().tabs) {
          if (tab.type === "request" && kind === "request" && tab.requestId === id) abortTab(tab.id);
        }
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
        const max = getSetting<number>("console.maxEntries") || 2000;
        const openOnError =
          getSetting<boolean>("console.openOnError") && entries.some((e) => e.level === "error");
        set((s) => ({
          consoleEntries: [...s.consoleEntries, ...entries].slice(-max),
          ...(openOnError ? { consoleOpen: true } : {}),
        }));
      },
      clearConsole: () => set({ consoleEntries: [] }),
      setConsoleOpen: (open) => set({ consoleOpen: open }),
      // The DOM is updated by the settings store (appearance.theme); this only tracks the resolved theme.
      setTheme(theme) {
        set({ theme });
      },
      setSidebarView: (sidebarView) => set({ sidebarView }),
    }),
    {
      name: "postbox-ui",
      version: 2,
      // Existing v1 browser state contains raw auth values and upload bytes.
      migrate: (persistedState) => sanitizeStoredState(persistedState),
      // Persist UI state and unsaved drafts, but not responses or server data.
      partialize: (s) => ({
        workspaceId: s.workspaceId,
        environmentId: s.environmentId,
        theme: s.theme,
        sidebarView: s.sidebarView,
        consoleOpen: s.consoleOpen,
        // With "Restore tabs on reload" off, tabs are not written to storage.
        activeTabId: getSetting<boolean>("tabs.restore") === false ? null : s.activeTabId,
        tabs: getSetting<boolean>("tabs.restore") === false ? [] : s.tabs.map(sanitizeStoredTab),
      }),
    },
  ),
);

/** A request tab with changes that would be lost on close. */
export function isTabDirty(t: Tab): boolean {
  if (t.type !== "request") return false;
  if (t.saved === null) return t.draft.url.trim() !== "" || t.draft.body.mode !== "none";
  return t.saved !== snapshot(t.draft);
}

/**
 * "Maximum open tabs": when a tab is added beyond the limit, close the oldest tabs that
 * are not active, not sending and have no unsaved changes.
 */
useApp.subscribe((state, prev) => {
  const max = getSetting<number>("tabs.maxOpen") || 0;
  if (!max || state.tabs.length <= prev.tabs.length || state.tabs.length <= max) return;
  const removable = state.tabs.filter(
    (t) => t.id !== state.activeTabId && !isTabDirty(t) && !(t.type === "request" && t.sending),
  );
  const drop = new Set(removable.slice(0, state.tabs.length - max).map((t) => t.id));
  if (drop.size) useApp.setState({ tabs: state.tabs.filter((t) => !drop.has(t.id)) });
});

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
