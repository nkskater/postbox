import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise store actions without browser storage or toast rendering.
vi.mock("zustand/middleware", () => ({ persist: (initializer: unknown) => initializer }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: {
    workspaces: { list: vi.fn(), tree: vi.fn() },
    environments: { list: vi.fn() },
    variables: { list: vi.fn() },
    requests: { update: vi.fn(), create: vi.fn(), get: vi.fn() },
    proxy: vi.fn(),
  },
}));

import { api, type ProxyResult, type SavedRequest } from "@/lib/api";
import { newDraft, sanitizeStoredState, snapshot, useApp, type Tab } from "@/stores/app";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requestTab(id = "tab", saved = true): Extract<Tab, { type: "request" }> {
  const draft = newDraft({ id: "request", name: "Original", url: "http://example.test", folderId: "folder" });
  return {
    id,
    type: "request",
    requestId: saved ? "request" : null,
    draft,
    saved: saved ? snapshot(draft) : null,
  };
}

function savedRequest(tab: Extract<Tab, { type: "request" }>): SavedRequest {
  return { ...tab.draft, folderId: "folder", workspaceId: "workspace", sort: 0 };
}

function current() {
  const tab = useApp.getState().tabs[0];
  if (tab.type !== "request") throw new Error("Expected request tab");
  return tab;
}

beforeEach(() => {
  vi.resetAllMocks();
  useApp.setState({ ...useApp.getInitialState(), workspaceId: "workspace" }, true);
  vi.mocked(api.workspaces.tree).mockResolvedValue({ folders: [], requests: [] });
  vi.mocked(api.workspaces.list).mockResolvedValue([{ id: "workspace", name: "Workspace" }]);
  vi.mocked(api.environments.list).mockResolvedValue([]);
  vi.mocked(api.variables.list).mockResolvedValue([]);
});

describe("request builder concurrency", () => {
  it("migrates legacy browser state without stored auth credentials or upload bytes", () => {
    const draft = newDraft({
      auth: { type: "bearer", bearer: { token: "legacy-token" } },
      body: { mode: "binary", binary: { fileName: "legacy.bin", data: "c2VjcmV0" } },
    });
    const migrated = sanitizeStoredState({
      workspaceId: "workspace",
      tabs: [{ ...requestTab(), draft, saved: snapshot(draft) }],
    });
    const storedTab = migrated.tabs[0];
    expect(storedTab.type).toBe("request");
    if (storedTab.type !== "request") throw new Error("Expected a request tab");
    expect(JSON.stringify(migrated)).not.toContain("legacy-token");
    expect(JSON.stringify(migrated)).not.toContain("c2VjcmV0");
    expect(storedTab.draft.auth).toEqual({ type: "bearer", bearer: { token: "" } });
    expect(storedTab.draft.body).toMatchObject({ mode: "binary", binary: { data: "", missing: true } });
    expect(storedTab.saved).not.toContain("legacy-token");
    expect(storedTab.credentialsOmitted).toBe(true);
  });

  it("does not save a browser draft while retained credentials are still being restored", async () => {
    const tab = { ...requestTab(), credentialsOmitted: true };
    useApp.setState({ tabs: [tab] });
    expect(await useApp.getState().saveTab(tab.id)).toBe(false);
    expect(api.requests.update).not.toHaveBeenCalled();
  });

  it("rehydrates saved auth and upload bytes from the server without replacing browser draft edits", async () => {
    const source = requestTab();
    const draft = {
      ...source.draft,
      auth: { type: "bearer", bearer: { token: "server-token" } } as const,
      body: { mode: "binary", binary: { fileName: "payload.bin", data: "cGF5bG9hZA==" } } as const,
      name: "Browser draft edit",
    };
    const persisted = sanitizeStoredState({
      workspaceId: "workspace",
      tabs: [{ ...source, draft, saved: snapshot(draft) }],
    }).tabs[0];
    if (persisted.type !== "request") throw new Error("Expected a request tab");
    useApp.setState({ tabs: [persisted], workspaceId: "workspace" });
    vi.mocked(api.workspaces.tree).mockResolvedValue({
      folders: [],
      requests: [{ id: "request" } as never],
    });
    vi.mocked(api.requests.get).mockResolvedValue({
      ...draft,
      auth: { type: "bearer", bearer: { token: "server-token" } },
      body: { mode: "binary", binary: { fileName: "payload.bin", data: "cGF5bG9hZA==" } },
      folderId: "folder",
      workspaceId: "workspace",
      sort: 0,
    });

    await useApp.getState().init();

    const restored = current();
    expect(restored.draft.name).toBe("Browser draft edit");
    expect(restored.draft.auth).toEqual({ type: "bearer", bearer: { token: "server-token" } });
    expect(restored.draft.body).toMatchObject({
      mode: "binary",
      binary: { data: "cGF5bG9hZA==", missing: false },
    });
    expect(restored.credentialsOmitted).toBe(false);
  });

  it("does not open a request loaded for a workspace that was left", async () => {
    const tab = requestTab();
    const pending = deferred<SavedRequest>();
    vi.mocked(api.requests.get).mockReturnValue(pending.promise);
    const opening = useApp.getState().openRequest("request");
    await useApp.getState().setWorkspace("different");
    pending.resolve(savedRequest(tab));
    await opening;
    expect(useApp.getState().tabs).toEqual([]);
  });

  it("keeps edits made while saving and records the saved baseline", async () => {
    const tab = requestTab();
    useApp.setState({ tabs: [tab] });
    const pending = deferred<SavedRequest>();
    vi.mocked(api.requests.update).mockReturnValue(pending.promise);
    const save = useApp.getState().saveTab(tab.id);
    useApp.getState().updateDraft(tab.id, { name: "Edited during save" });
    pending.resolve(savedRequest(tab));
    expect(await save).toBe(true);
    expect(current().draft.name).toBe("Edited during save");
    expect(JSON.parse(current().saved!).name).toBe("Original");
    expect(snapshot(current().draft)).not.toBe(current().saved);
  });

  it("does not create duplicate saved requests on repeated saves", async () => {
    const tab = requestTab("new", false);
    useApp.setState({ tabs: [tab] });
    const pending = deferred<SavedRequest>();
    vi.mocked(api.requests.create).mockReturnValue(pending.promise);
    const target = { folderId: "folder", name: "Saved name" };
    const save = useApp.getState().saveTab(tab.id, target);
    expect(await useApp.getState().saveTab(tab.id, target)).toBe(false);
    useApp.getState().updateDraft(tab.id, { url: "http://edited.test" });
    pending.resolve({ ...savedRequest(tab), id: "created", name: target.name });
    await save;
    expect(api.requests.create).toHaveBeenCalledTimes(1);
    expect(current().requestId).toBe("created");
    expect(current().draft).toMatchObject({ id: "created", name: "Saved name", url: "http://edited.test" });
  });

  it("ignores an old send's abort when a replacement send is pending", async () => {
    const tab = requestTab();
    useApp.setState({ tabs: [tab] });
    const first = deferred<ProxyResult>();
    const second = deferred<ProxyResult>();
    vi.mocked(api.proxy).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const send1 = useApp.getState().sendTab(tab.id);
    const send2 = useApp.getState().sendTab(tab.id);
    expect(vi.mocked(api.proxy).mock.calls[0][1]?.aborted).toBe(true);
    first.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    await send1;
    expect(current().sending).toBe(true);
    second.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    await send2;
    expect(current().sending).toBe(false);
  });

  it("aborts requests when their tabs are closed", async () => {
    const tab = requestTab("closed");
    const retained = requestTab("retained");
    useApp.setState({ tabs: [tab, retained] });
    const pending = deferred<ProxyResult>();
    vi.mocked(api.proxy).mockReturnValue(pending.promise);
    const send = useApp.getState().sendTab(tab.id);
    useApp.getState().closeOtherTabs(retained.id);
    expect(vi.mocked(api.proxy).mock.calls[0][1]?.aborted).toBe(true);
    pending.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    await send;
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual([retained.id]);
  });

  it("ignores stale workspace responses even when switching back to the same ID", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.workspaces.tree>>>();
    vi.mocked(api.workspaces.tree).mockReturnValueOnce(old.promise);
    const first = useApp.getState().setWorkspace("a");
    await useApp.getState().setWorkspace("b");
    await useApp.getState().setWorkspace("a");
    old.resolve({ folders: [{ id: "stale", parentId: null, name: "Old", sort: 0 }], requests: [] });
    await first;
    expect(useApp.getState().workspaceId).toBe("a");
    expect(useApp.getState().folders).toEqual([]);
  });

  it("keeps variables from the latest environment selection", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.variables.list>>>();
    vi.mocked(api.variables.list).mockImplementation(async (_ws, scope, owner) => {
      if (scope === "environment" && owner === "old") return old.promise;
      return scope === "environment"
        ? [{ key: "selected", value: "new", type: "default", enabled: true }]
        : [];
    });
    useApp.setState({ environmentId: "old" });
    const first = useApp.getState().refreshVariables();
    useApp.setState({ environmentId: "new" });
    await useApp.getState().refreshVariables();
    old.resolve([{ key: "selected", value: "old", type: "default", enabled: true }]);
    await first;
    expect(useApp.getState().variables.selected.value).toBe("new");
  });
});
