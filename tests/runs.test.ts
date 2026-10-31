import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { createEventStream } from "@/server/event-stream";
import type { StartRunEvent } from "@/server/runs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-runs-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
let server: TestServer;
let repo: typeof import("@/server/repo");
let runs: typeof import("@/server/runs");
let db: typeof import("@/server/db");

beforeAll(async () => {
  repo = await import("@/server/repo");
  runs = await import("@/server/runs");
  db = await import("@/server/db");
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function collection() {
  const ws = repo.createWorkspace("Persisted run");
  const folder = repo.createFolder(ws.id, null, { name: "Collection" });
  repo.createRequest(ws.id, folder.id, { url: server.url + "/echo" });
  return { workspaceId: ws.id, folderId: folder.id, environmentId: null };
}

describe("persisted collection runs", () => {
  it("continues persisting results when a progress subscriber falls behind", async () => {
    const events = createEventStream(1);
    // Observe the intentional transport failure while the job continues.
    const disconnected = expect(events.stream.getReader().read()).rejects.toThrow(/too slow/);
    const { runId, summary } = await runs.startRun({
      ...collection(),
      retainResults: false,
      options: { iterations: 3 },
      onEvent: events.send,
    });
    await disconnected;
    events.close();
    expect(summary).toMatchObject({ status: "passed", totalRequests: 3, results: [] });
    expect(runs.getRunSummary(runId)!.results).toHaveLength(3);
  });

  it("persists every result without retaining it and publishes done after database finalization", async () => {
    const input = collection();
    const signal = new AbortController().signal;
    let persistedAtDone: ReturnType<typeof runs.getRunSummary>;
    const { runId, summary } = await runs.startRun({
      ...input,
      signal,
      retainResults: false,
      options: { iterations: 3 },
      onEvent: (event) => {
        if (event.type === "done") persistedAtDone = runs.getRunSummary(event.runId);
      },
    });
    expect(summary.results).toEqual([]);
    expect(summary.totalRequests).toBe(3);
    const persisted = runs.getRunSummary(runId)!;
    expect(persisted.results).toHaveLength(3);
    expect(persisted).toMatchObject({ status: "passed", totalRequests: 3 });
    expect(persistedAtDone!).toMatchObject({ status: "passed", totalRequests: 3 });
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(runs.cancelRun(runId)).toBe(false);
  });

  it("keeps full returned results for existing callers by default", async () => {
    const { summary } = await runs.startRun(collection());
    expect(summary.results).toHaveLength(1);
  });

  it("does not emit success when final persistence fails", async () => {
    const input = collection();
    const events: StartRunEvent[] = [];
    const signal = new AbortController().signal;
    const failure = vi.spyOn(repo, "saveCookies").mockImplementation(() => {
      throw new Error("Storage failed");
    });
    try {
      await expect(
        runs.startRun({ ...input, signal, onEvent: (event) => events.push(event) }),
      ).rejects.toThrow("Storage failed");
    } finally {
      failure.mockRestore();
    }
    expect(events.some((event) => event.type === "done")).toBe(false);
    const runId = events[0].runId;
    expect(runs.getRunSummary(runId)).toMatchObject({ status: "error", error: "Storage failed" });
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(runs.cancelRun(runId)).toBe(false);
  });

  it("honors a parent signal that was aborted before starting", async () => {
    const { summary } = await runs.startRun({ ...collection(), signal: AbortSignal.abort() });
    expect(summary).toMatchObject({ status: "cancelled", totalRequests: 0 });
  });
});
