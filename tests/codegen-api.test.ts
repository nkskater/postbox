import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-codegen-")), "test.db");
let route: typeof import("@/app/api/codegen/route");
let repo: typeof import("@/server/repo");
let workspaceId: string, folderId: string, environmentId: string;
beforeAll(async () => {
  route = await import("@/app/api/codegen/route");
  repo = await import("@/server/repo");
  workspaceId = repo.createWorkspace("Code snippets").id;
  folderId = repo.createFolder(workspaceId, null, {
    name: "API",
    auth: { type: "bearer", bearer: { token: "{{token}}" } },
    headers: [{ key: "X-Inherited", value: "yes", enabled: true }],
  }).id;
  environmentId = repo.createEnvironment(workspaceId, "Dev").id;
  repo.replaceVariables(workspaceId, "environment", environmentId, [
    { key: "host", value: "https://api.test", enabled: true, type: "default" },
    { key: "value", value: "café", enabled: true, type: "default" },
    { key: "token", value: "credential", enabled: true, type: "secret" },
  ]);
});
const post = (language: string, extra: Record<string, unknown> = {}) =>
  route.POST(
    new Request("http://localhost/api/codegen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        environmentId,
        folderId,
        language,
        request: {
          method: "POST",
          url: "{{host}}/items",
          auth: { type: "inherit" },
          body: { mode: "raw", language: "json", raw: '{"value":"{{value}}"}' },
        },
        ...extra,
      }),
    }),
  );

describe("snippet REST contract", () => {
  it("discovers the same target IDs and option settings used by clients", async () => {
    const response = await route.GET();
    const { targets } = await response.json();
    expect(targets).toHaveLength(36);
    expect(targets.find((t: { id: string }) => t.id === "java-okhttp").options).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "includeBoilerplate", type: "boolean" })]),
    );
  });
  it("resolves body, URL, inherited headers and auth in an extended target", async () => {
    const response = await post("nodejs-axios");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.code).toContain("https://api.test/items");
    expect(result.code).toContain('{"value":"café"}');
    expect(result.code).toContain("Bearer credential");
    expect(result.code).toContain("X-Inherited");
    expect(result.warnings).toEqual([]);
    const template = await (await post("nodejs-axios", { resolveVariables: false })).json();
    expect(template.code).toContain("{{host}}");
    expect(template.code).toContain("{{value}}");
    expect(template.code).toContain("{{token}}");
  });
  it("rejects unsupported targets and options as client errors", async () => {
    for (const [language, options] of [
      ["invalid", {}],
      ["java-okhttp", { indentCount: 100 }],
      ["fetch", { followRedirect: false }],
      ["python", { indentType: "invalid" }],
    ] as const) {
      expect((await post(language, { options })).status).toBe(400);
    }
  });
  it("keeps prepared multipart boundary, duplicates and uploaded bytes together", async () => {
    const response = await post("fetch", {
      request: {
        method: "POST",
        url: "https://api.test/upload",
        body: {
          mode: "formdata",
          formdata: [
            { key: "tag", value: "one", enabled: true, type: "text" },
            { key: "tag", value: "two", enabled: true, type: "text" },
            { key: "file", value: "", enabled: true, type: "file", fileName: "input.bin", data: "AP8=" },
          ],
        },
      },
    });
    expect(response.status).toBe(200);
    const { code, warnings } = await response.json();
    let captured: { headers: Headers; body: Uint8Array } | undefined;
    await new vm.Script(`(async()=>{${code}})()`).runInNewContext({
      Headers,
      atob,
      Uint8Array,
      console: { log() {} },
      fetch: async (_url: string, opts: { headers: Headers; body: Uint8Array }) => {
        captured = opts;
        return { status: 200, text: async () => "" };
      },
    });
    const body = Buffer.from(captured!.body);
    const boundary = captured!.headers.get("Content-Type")!.split("boundary=")[1];
    expect(body.toString("latin1")).toContain(`--${boundary}`);
    expect(body.toString("latin1").match(/name="tag"/g)).toHaveLength(2);
    expect(body.includes(Buffer.from([0, 255]))).toBe(true);
    expect(warnings.join(" ")).toContain("bytes are embedded");
  });
  it("explains offline challenge authentication rather than implying a signed request", async () => {
    const response = await post("java-okhttp", {
      request: {
        method: "GET",
        url: "https://api.test",
        auth: { type: "digest", digest: { username: "user", password: "secret" } },
      },
    });
    const { warnings } = await response.json();
    expect(warnings.join(" ")).toContain("DIGEST");
  });
});
