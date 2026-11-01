import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-contract-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const repo = await import("@/server/repo");
const { getDb, getSqlite } = await import("@/server/db");
const { runSingleRequest } = await import("@/server/context");
const { parseContract } = await import("@/core/contracts/validate");
const { contractReport } = await import("@/core/contracts/report");
let server: http.Server, base: string;
let hits = 0;
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end('{"id":7}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const contract = parseContract({
  parameters: [{ in: "query", name: "limit", required: true, schema: { type: "integer", maximum: 10 } }],
  responseBody: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
  responseStatus: [200],
});
const setup = () => {
  const ws = repo.createWorkspace("Contracts"),
    folder = repo.createFolder(ws.id, null);
  return { ws, folder };
};
describe("persisted contract integration", () => {
  it("preserves contract across CRUD, duplication, collection export/import and backup restore", async () => {
    const { ws, folder } = setup();
    const request = repo.createRequest(ws.id, folder.id, { url: base, contract });
    expect(repo.getRequest(request.id)?.contract).toEqual(contract);
    expect(repo.duplicateRequest(request.id)?.contract).toEqual(contract);
    const { exportPostmanCollection, importPostmanCollection } = await import("@/core/convert/postman");
    const tree = repo.getFolderTree(folder.id)!;
    const imported = importPostmanCollection(exportPostmanCollection(tree));
    expect(
      imported.root.children
        .filter((n) => n.kind === "request")
        .every((n) => n.contract?.responseStatus?.[0] === 200),
    ).toBe(true);
    const backup = await import("@/server/backup");
    const dump = backup.createBackup(getDb(), { includeSecrets: true });
    expect(JSON.stringify(dump)).toContain('"contract"');
    repo.updateRequest(request.id, { contract: null });
    expect(repo.getRequest(request.id)?.contract).toBeNull();
    // Restore uses the same generic request JSON columns as other metadata.
    backup.restoreBackup(getDb(), getSqlite(), dump);
    expect(repo.getRequest(request.id)?.contract).toEqual(contract);
  });
  it("validates saved examples and templates without sending requests or running scripts", () => {
    const { ws, folder } = setup();
    const request = repo.createRequest(ws.id, folder.id, {
      url: base + "?limit={{limit}}",
      contract,
      preRequestScript: 'throw new Error("must not run")',
      examples: [
        {
          id: "ex1",
          name: "Wrong ID",
          status: 200,
          statusText: "OK",
          headers: [],
          body: '{"id":"wrong"}',
          createdAt: 1,
        },
      ],
    });
    const before = hits;
    const result = contractReport(request);
    expect(result.request[0].status).toBe("deferred");
    expect(result.examples[0].diagnostics.some((d) => d.status === "error")).toBe(true);
    expect(hits).toBe(before);
  });
  it("serves the saved validation report through REST without replaying examples", async () => {
    const { ws, folder } = setup();
    const request = repo.createRequest(ws.id, folder.id, { url: base + "?limit=20", contract });
    const { GET } = await import("@/app/api/requests/[id]/contract-validation/route");
    const before = hits;
    const response = await GET(
      new Request(`http://localhost/api/requests/${request.id}/contract-validation`),
      { params: Promise.resolve({ id: request.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).request.some((d: { status: string }) => d.status === "error")).toBe(true);
    expect(hits).toBe(before);
  });
  it("fails collection results on contract failures using the shared HTTP executor", async () => {
    const { ws, folder } = setup();
    repo.createRequest(ws.id, folder.id, { url: base + "?limit=99", contract });
    const { runCollection } = await import("@/core/runner/runner");
    const { emptyScopes } = await import("@/core/variables/resolver");
    const { DEFAULT_RUN_OPTIONS } = await import("@/core/types");
    const { summary } = await runCollection({
      root: repo.getFolderTree(folder.id)!,
      scopes: emptyScopes(),
      options: DEFAULT_RUN_OPTIONS,
    });
    expect(summary.status).toBe("failed");
    expect(summary.failedTests).toBe(1);
    expect(summary.results[0].tests.some((t) => t.name.startsWith("Contract:") && !t.passed)).toBe(true);
  });
  it("validates actual prepared values after pre-request scripts and inherited headers, and reports response failures as tests", async () => {
    const { ws, folder } = setup();
    repo.updateFolder(folder.id, { headers: [{ key: "X-Inherited", value: "yes", enabled: true }] });
    const withHeader = parseContract({
      ...contract,
      parameters: [
        ...contract.parameters,
        { in: "header", name: "X-Inherited", required: true, schema: { const: "yes" } },
      ],
    });
    const request = repo.createRequest(ws.id, folder.id, {
      url: base + "?limit={{limit}}",
      contract: withHeader,
      preRequestScript: 'pm.variables.set("limit", "3");',
    });
    const before = hits;
    const result = await runSingleRequest({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      request,
    });
    expect(hits).toBe(before + 1);
    expect(result.tests.filter((t) => t.name.startsWith("Contract:"))).toHaveLength(4);
    expect(result.tests.every((t) => t.passed)).toBe(true);
    const failed = await runSingleRequest({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      request: {
        ...request,
        contract: { ...contract, responseBody: { type: "object", required: ["missing"] } },
        url: base + "?limit=999",
        preRequestScript: "",
      },
    });
    expect(failed.tests.filter((t) => !t.passed)).toHaveLength(2);
    expect(failed.response?.status).toBe(200);
  });
});
