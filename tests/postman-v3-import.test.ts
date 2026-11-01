import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-v3-import-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const repo = await import("@/server/repo");
const { importContent } = await import("@/server/importer");
const exportRoute = await import("@/app/api/export/collection/[id]/route");

const fixture = fs.readFileSync(
  path.join(process.cwd(), "tests/fixtures/postman-v3/orders.collection.json"),
  "utf8",
);
const schema = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tests/fixtures/postman-v3/collection.schema.json"), "utf8"),
);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const exportCollection = (id: string, query: string) =>
  exportRoute.GET(new Request(`http://localhost/api/export/collection/${id}?${query}`), {
    params: Promise.resolve({ id }),
  });

describe("Postman v3 through the shared importer", () => {
  const workspaceId = repo.createWorkspace("V3").id;

  it("previews without saving and lists what will not be kept", () => {
    const before = repo.getTreeSummary(workspaceId).folders.length;
    const preview = importContent(workspaceId, fixture, undefined, { preview: true });
    expect(preview).toMatchObject({
      kind: "preview",
      source: "postman-v3",
      name: "Orders API",
      folders: 2,
      requests: 6,
      variables: 3,
    });
    expect(preview.kind === "preview" && preview.warnings).toEqual([
      'Orders API: Secret variable "apiToken" has no value in the file; it is imported empty',
    ]);
    expect(repo.getTreeSummary(workspaceId).folders.length).toBe(before);
  });

  it("refuses to preview formats it cannot preview, saving nothing", () => {
    expect(() =>
      importContent(workspaceId, JSON.stringify({ info: { name: "x" }, item: [] }), undefined, {
        preview: true,
      }),
    ).toThrow(/Preview currently supports/);
  });

  it("imports the collection and its variables", () => {
    const result = importContent(workspaceId, fixture);
    expect(result).toMatchObject({
      kind: "collection",
      source: "postman-v3",
      name: "Orders API",
      requests: 6,
    });
    if (result.kind !== "collection") throw new Error("unexpected");
    const keys = repo.listVariables(workspaceId, "collection", result.id).map((variable) => variable.key);
    expect(keys).toEqual(["baseUrl", "legacy", "apiToken"]);
  });

  it("still imports v2.1 and YAML-wrapped v3", () => {
    const v21 = importContent(
      workspaceId,
      JSON.stringify({
        info: { name: "Old" },
        item: [{ name: "r", request: { method: "GET", url: "https://x.test" } }],
      }),
    );
    expect(v21).toMatchObject({ kind: "collection", source: "postman", requests: 1 });
    const yaml = importContent(
      workspaceId,
      "$kind: collection\nname: From YAML\nitems:\n  - $kind: http-request\n    name: r\n    url: https://x.test\n    method: GET\n",
    );
    expect(yaml).toMatchObject({ kind: "collection", source: "postman-v3", name: "From YAML", requests: 1 });
  });

  it("exports v2.1 by default and v3 on request, and v3 passes the official schema", async () => {
    const result = importContent(workspaceId, fixture);
    if (result.kind !== "collection") throw new Error("unexpected");
    const v21 = JSON.parse(await (await exportCollection(result.id, "")).text());
    expect(v21.info.schema).toContain("v2.1.0");

    const response = await exportCollection(result.id, "format=v3&includeCredentials=1");
    expect(response.headers.get("content-disposition")).toContain(".postman_collection.v3.json");
    const v3 = JSON.parse(await response.text());
    expect(validate(v3), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    expect(v3.$kind).toBe("collection");
    expect(v3.name).toBe("Orders API");

    const report = JSON.parse(await (await exportCollection(result.id, "format=v3&report=1")).text());
    expect(report.diagnostics).toEqual([
      {
        level: "lossy",
        path: "Orders API",
        message: 'Secret variable "apiToken" is exported without a value, as v3 cannot hold one',
      },
    ]);
    expect(validate(report.collection)).toBe(true);

    expect((await exportCollection(result.id, "format=v9")).status).toBe(400);
  });
});
