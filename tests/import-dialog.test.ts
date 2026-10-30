import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImportController, type FileImportLike } from "@/components/dialogs/ImportDialog";
import type { RequestDraft } from "@/stores/app";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockFile(name: string, content: string | (() => Promise<string>)): FileImportLike {
  return {
    name,
    text: typeof content === "function" ? content : async () => content,
  };
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ImportDialog multi-file recovery and concurrency", () => {
  let sidebarCollections: string[];
  let persistedCollections: string[];
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let refreshEnvironments: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let refreshVariables: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let openDraft: ReturnType<typeof vi.fn<(partial?: Partial<RequestDraft>) => void>>;
  let setDialogOpen: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let toastSuccess: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let toastError: ReturnType<typeof vi.fn<(msg: string) => void>>;

  beforeEach(() => {
    sidebarCollections = [];
    persistedCollections = [];
    refreshTree = vi.fn(async () => {
      // Simulate sidebar syncing with server-persisted collections.
      sidebarCollections = [...persistedCollections];
    });
    refreshEnvironments = vi.fn(async () => {});
    refreshVariables = vi.fn(async () => {});
    openDraft = vi.fn();
    setDialogOpen = vi.fn();
    toastSuccess = vi.fn();
    toastError = vi.fn();
  });

  function setup(fetchImpl: typeof fetch) {
    return createImportController(
      {
        getWorkspaceId: () => "ws-1",
        refreshTree,
        refreshEnvironments,
        refreshVariables,
        openDraft,
        setDialogOpen,
        fetchImpl,
        toastImpl: {
          success: toastSuccess,
          error: toastError,
        },
      },
      { open: true },
    );
  }

  it("keeps single-file imports working as before", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      persistedCollections.push("Single API");
      return jsonResponse({ kind: "collection", name: "Single API", requests: 3 });
    });
    const ctrl = setup(fetchMock);

    const summary = await ctrl.importFiles([mockFile("single.json", '{"openapi":"3.0.0"}')]);
    expect(summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(refreshEnvironments).toHaveBeenCalledTimes(1);
    expect(refreshVariables).toHaveBeenCalledTimes(1);
    expect(sidebarCollections).toEqual(["Single API"]);
    expect(setDialogOpen).toHaveBeenLastCalledWith(false);
    expect(ctrl.getState().open).toBe(false);
    expect(ctrl.getState().batchSummary).toBeNull();
  });

  it("refreshes persisted file A after file B fails, and retries only file B without duplicating file A", async () => {
    let fileBContent = "not-valid-spec";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { content: string };
      if (payload.content.includes("Collection A")) {
        persistedCollections.push("Collection A");
        return jsonResponse({ kind: "collection", name: "Collection A", requests: 2 });
      }
      if (payload.content.includes("Collection B")) {
        persistedCollections.push("Collection B");
        return jsonResponse({ kind: "collection", name: "Collection B", requests: 4 });
      }
      return jsonResponse({ error: "Unrecognized import format" }, 400);
    });

    const ctrl = setup(fetchMock);
    const fileA = mockFile("a.json", '{"name":"Collection A"}');
    const fileB = mockFile("b.json", async () => fileBContent);

    // First batch: A succeeds, B fails.
    const firstBatch = await ctrl.importFiles([fileA, fileB]);
    expect(firstBatch).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(firstBatch?.entries.map((e) => [e.name, e.status, e.error ?? e.summary])).toEqual([
      ["a.json", "succeeded", 'Imported collection "Collection A" (2 requests)'],
      ["b.json", "failed", "Unrecognized import format"],
    ]);

    // Sidebar MUST already show Collection A once even though B failed.
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(sidebarCollections).toEqual(["Collection A"]);
    // Dialog remains open with the batch outcome summary so user can retry failed files.
    expect(ctrl.getState().open).toBe(true);
    expect(ctrl.getState().batchSummary?.failed).toBe(1);

    // User fixes B and clicks "Retry failed".
    fileBContent = '{"name":"Collection B"}';
    const retryBatch = await ctrl.retryFailedFiles();
    expect(retryBatch).toMatchObject({
      total: 2,
      succeeded: 2,
      failed: 0,
    });

    // Only 3 total API calls: A (once), B (failed), B (retried). A was never re-imported.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sidebarCollections).toEqual(["Collection A", "Collection B"]);
    expect(ctrl.getState().open).toBe(false);
    expect(ctrl.getState().batchSummary).toBeNull();
    expect(setDialogOpen).toHaveBeenLastCalledWith(false);
  });

  it("handles network failure midway through a multi-file batch and retries only the failed file", async () => {
    let failNetworkForB = true;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const { content } = JSON.parse(String(init?.body ?? "{}")) as { content: string };
      if (content === "spec-b" && failNetworkForB) {
        throw new TypeError("fetch failed: network timeout");
      }
      persistedCollections.push(content);
      return jsonResponse({ kind: "collection", name: content, requests: 1 });
    });

    const ctrl = setup(fetchMock);
    const fileA = mockFile("a.yaml", "spec-a");
    const fileB = mockFile("b.yaml", "spec-b");
    const fileC = mockFile("c.yaml", "spec-c");

    const batch1 = await ctrl.importFiles([fileA, fileB, fileC]);
    expect(batch1).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(sidebarCollections).toEqual(["spec-a", "spec-c"]);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(ctrl.getState().batchSummary?.entries.map((e) => [e.name, e.status])).toEqual([
      ["a.yaml", "succeeded"],
      ["b.yaml", "failed"],
      ["c.yaml", "succeeded"],
    ]);

    // Network recovers; retrying failed files runs ONLY b.yaml.
    failNetworkForB = false;
    const batch2 = await ctrl.retryFailedFiles();
    expect(batch2).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sidebarCollections).toEqual(["spec-a", "spec-c", "spec-b"]);
    expect(ctrl.getState().open).toBe(false);
  });

  it("preserves batch ledger when refresh rejects after a partial import so retry does not duplicate persisted files", async () => {
    let fileBContent = "broken-spec";
    let failRefreshOnce = true;
    refreshTree.mockImplementation(async () => {
      if (failRefreshOnce) {
        failRefreshOnce = false;
        throw new Error("Sidebar refresh failed");
      }
      sidebarCollections = [...persistedCollections];
    });

    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const { content } = JSON.parse(String(init?.body ?? "{}")) as { content: string };
      if (content === "broken-spec") {
        return jsonResponse({ error: "Unrecognized import format" }, 400);
      }
      persistedCollections.push(content);
      return jsonResponse({ kind: "collection", name: content, requests: 1 });
    });

    const ctrl = setup(fetchMock);
    const fileA = mockFile("a.json", "Collection A");
    const fileB = mockFile("b.json", async () => fileBContent);

    const firstBatch = await ctrl.importFiles([fileA, fileB]);
    expect(firstBatch).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(ctrl.getState().batchSummary?.entries.map((e) => [e.name, e.status])).toEqual([
      ["a.json", "succeeded"],
      ["b.json", "failed"],
    ]);
    expect(toastError).toHaveBeenCalledWith("Sidebar refresh failed");

    // Retrying failed files must only retry b.json and must not re-import a.json.
    fileBContent = "Collection B";
    const retryBatch = await ctrl.retryFailedFiles();
    expect(retryBatch).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(persistedCollections).toEqual(["Collection A", "Collection B"]);
    expect(sidebarCollections).toEqual(["Collection A", "Collection B"]);
    expect(ctrl.getState().open).toBe(false);
  });

  it("ignores empty file selections without side effects", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const ctrl = setup(fetchMock);

    expect(await ctrl.importFiles([])).toBeNull();
    expect(await ctrl.importFiles(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(ctrl.getState().open).toBe(true);
  });

  it("handles cURL files mixed with collection files without duplicating cURL tabs on retry", async () => {
    let allowCollection = false;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (!allowCollection) {
        return jsonResponse({ error: "Invalid OpenAPI spec" }, 400);
      }
      persistedCollections.push("Orders API");
      return jsonResponse({ kind: "collection", name: "Orders API", requests: 5 });
    });

    const ctrl = setup(fetchMock);
    const curlFile = mockFile(
      "request.sh",
      "curl -X POST https://api.example.com/v1/orders?dryRun=1 -H 'X-Test: 1' --data-raw '{\"sku\":\"abc\"}'",
    );
    const collectionFile = mockFile("orders.json", '{"openapi":"3.0.0"}');

    // First run: cURL succeeds (opens draft tab), collection file fails.
    const batch1 = await ctrl.importFiles([curlFile, collectionFile]);
    expect(batch1).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(openDraft).toHaveBeenCalledTimes(1);
    expect(openDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://api.example.com/v1/orders?dryRun=1",
      }),
    );
    // No server-persisted file succeeded yet, so refreshTree was not needed.
    expect(refreshTree).not.toHaveBeenCalled();
    expect(ctrl.getState().open).toBe(true);

    // Retry failed files: only orders.json runs; cURL draft tab is NOT duplicated.
    allowCollection = true;
    const batch2 = await ctrl.retryFailedFiles();
    expect(batch2).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(openDraft).toHaveBeenCalledTimes(1);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(sidebarCollections).toEqual(["Orders API"]);
    expect(ctrl.getState().open).toBe(false);
  });

  it("blocks overlapping drop, file, paste, link and close actions while an import is active", async () => {
    const pendingFetch = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => pendingFetch.promise);
    const ctrl = setup(fetchMock);

    const firstImport = ctrl.importFiles([mockFile("first.json", '{"openapi":"3.0.0"}')]);
    expect(ctrl.getState().busy).toBe(true);

    // Duplicate/overlapping submissions while busy must be ignored.
    expect(await ctrl.importFiles([mockFile("second.json", '{"openapi":"3.0.0"}')])).toBeNull();
    ctrl.setText("curl https://duplicate.example.com");
    expect(ctrl.getState().text).toBe("");
    expect(await ctrl.importText()).toBe(false);
    ctrl.setLink("https://duplicate.example.com/openapi.json");
    expect(ctrl.getState().link).toBe("");
    expect(await ctrl.importLink()).toBe(false);
    expect(await ctrl.retryFailedFiles()).toBeNull();
    expect(ctrl.handleOpenChange(false)).toBe(false);

    // Complete the in-flight request.
    persistedCollections.push("First API");
    pendingFetch.resolve(jsonResponse({ kind: "collection", name: "First API", requests: 1 }));
    await firstImport;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctrl.getState().busy).toBe(false);
    expect(sidebarCollections).toEqual(["First API"]);
  });

  it("preserves failed raw text and link inputs for correction and clears them once corrected", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string; url?: string };
      if (body.content === "broken-json") {
        return jsonResponse({ error: "Unrecognized import format" }, 400);
      }
      if (body.url === "https://bad.example.com/spec.json") {
        return jsonResponse({ error: "Fetching https://bad.example.com/spec.json failed with status 404" }, 400);
      }
      persistedCollections.push(body.content ? "From Text" : "From Link");
      return jsonResponse({
        kind: "collection",
        name: body.content ? "From Text" : "From Link",
        requests: 1,
      });
    });

    const ctrl = setup(fetchMock);

    // 1. Failed text import keeps text for editing.
    ctrl.setText("broken-json");
    expect(await ctrl.importText()).toBe(false);
    expect(ctrl.getState().open).toBe(true);
    expect(ctrl.getState().text).toBe("broken-json");
    expect(ctrl.getState().textError).toBe("Unrecognized import format");

    // Correcting text and retrying succeeds and clears text.
    ctrl.setText('{"openapi":"3.0.0"}');
    expect(ctrl.getState().textError).toBeNull();
    expect(await ctrl.importText()).toBe(true);
    expect(ctrl.getState().text).toBe("");
    expect(ctrl.getState().open).toBe(false);

    // Re-open dialog for link import test.
    ctrl.handleOpenChange(true);
    ctrl.setLink("https://bad.example.com/spec.json");
    expect(await ctrl.importLink()).toBe(false);
    expect(ctrl.getState().open).toBe(true);
    expect(ctrl.getState().link).toBe("https://bad.example.com/spec.json");
    expect(ctrl.getState().linkError).toContain("404");

    // Correcting link and retrying succeeds and clears link.
    ctrl.setLink("https://good.example.com/spec.json");
    expect(ctrl.getState().linkError).toBeNull();
    expect(await ctrl.importLink()).toBe(true);
    expect(ctrl.getState().link).toBe("");
    expect(ctrl.getState().open).toBe(false);
  });
});
