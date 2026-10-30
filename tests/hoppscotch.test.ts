import { describe, expect, it } from "vitest";
import { importHoppscotch, isHoppscotch } from "@/core/convert/hoppscotch";
import { Resolver, emptyScopes, variablesToRecord } from "@/core/variables/resolver";
import { prepareRequest } from "@/core/http/prepare";
import type { RequestNode, FolderNode } from "@/core/types";
import { createImportController } from "@/components/dialogs/ImportDialog";

const request = (v: string = "17") => ({
  v,
  name: "Create",
  method: "POST",
  endpoint: "<<base>>/echo",
  headers: [
    { key: "X-Token", value: "<<token>>", active: true },
    { key: "X-Off", value: "off", active: false },
  ],
  params: [
    { key: "q", value: "<<value>>", active: true },
    { key: "off", value: "no", active: false },
  ],
  auth: { authType: "basic", authActive: true, username: "user", password: "<<token>>" },
  body: { contentType: "application/json", body: '{"value":"<<value>>"}' },
  preRequestScript: "",
  testScript: "",
});
const collection = (v = 12) => ({
  v,
  name: "Fixture",
  folders: [] as unknown[],
  requests: [request()] as unknown[],
  variables: [
    { key: "base", currentValue: "https://example.test", initialValue: "", secret: false },
    { key: "token", currentValue: "credential", secret: true },
    { key: "value", currentValue: "outer", secret: false },
  ],
});
const convert = (value: unknown) => importHoppscotch(value, { includeCredentials: true });

describe("Hoppscotch migration", () => {
  it("requires explicit credential consent before mapping any payload", () => {
    expect(() => importHoppscotch(collection())).toThrow(/includeCredentials/);
    expect(isHoppscotch(collection())).toBe(true);
    expect(isHoppscotch([{ v: 2, name: "Environment", variables: [] }])).toBe(true);
  });
  it("recognizes supported version envelopes and rejects future versions", () => {
    for (let v = 1; v <= 12; v++) expect(convert(collection(v)).items).toHaveLength(1);
    for (let v = 1; v <= 17; v++) {
      const c = collection();
      c.requests = [request(String(v))];
      expect(convert(c).items).toHaveLength(1);
    }
    expect(() => convert(collection(13))).toThrow(/version/);
    const c = collection();
    c.requests = [request("18")];
    expect(() => convert(c)).toThrow(/version/);
  });
  it("preserves variable overrides, disabled entries and resolved request semantics", async () => {
    const c = collection();
    const nested = collection();
    nested.name = "Nested";
    nested.variables = [{ key: "value", currentValue: "inner", secret: false }];
    c.folders = [nested];
    const item = convert(c).items[0];
    if (item.kind !== "collection") throw new Error("Expected collection");
    const folder = item.root.children[0] as FolderNode;
    const r = folder.children[0] as RequestNode;
    const resolver = new Resolver({ ...emptyScopes(), collection: variablesToRecord(item.variables) });
    const { prepared } = await prepareRequest(r, [item.root, folder], resolver, undefined, { offline: true });
    expect(prepared.url).toBe("https://example.test/echo?q=inner");
    expect(prepared.headers).toContainEqual(["X-Token", "credential"]);
    expect(prepared.headers.some(([key]) => key === "X-Off")).toBe(false);
    expect(prepared.headers).toContainEqual([
      "Authorization",
      "Basic " + Buffer.from("user:credential").toString("base64"),
    ]);
    expect(prepared.body?.toString()).toBe('{"value":"inner"}');
    expect(r.params[1].enabled).toBe(false);
    expect(r.settings.useCookieJar).toBe(false);
    expect(item.variables.find((v) => v.key === "token")?.type).toBe("secret");
    expect(item.variables.find((v) => v.key === "value")?.value).toBe("outer");
  });
  it("migrates environment values and batches without losing disabled or secret flags", () => {
    const result = convert([
      { name: "Legacy", variables: [{ key: "key", value: "old", active: false }] },
      {
        v: 2,
        name: "Current",
        variables: [{ key: "secret", initialValue: "fallback", currentValue: "", secret: true }],
      },
    ]);
    expect(result.items).toMatchObject([
      { kind: "environment", variables: [{ value: "old", enabled: false }] },
      { kind: "environment", variables: [{ value: "fallback", type: "secret" }] },
    ]);
    expect(() => convert({ v: 3, name: "Future", variables: [] })).toThrow(/version/);
  });
  it("maps legacy endpoint/auth/body, forms and GraphQL requests and reports scripts/settings/auth gaps", () => {
    const c = collection();
    c.requests = [
      {
        name: "Legacy",
        url: "https://example.test",
        path: "/old",
        method: "POST",
        auth: "Bearer Token",
        bearerToken: "token",
        contentType: "application/json",
        rawParams: '{"old":true}',
      },
      {
        ...request(),
        name: "Form",
        auth: { authType: "api-key", authActive: true, addTo: "QUERY_PARAMS", key: "key", value: "value" },
        body: {
          contentType: "multipart/form-data",
          body: [{ key: "off", value: "no", active: false, isFile: false }],
        },
      },
      { name: "GraphQL", url: "https://example.test/graphql", query: "{ hello }", variables: "{}" },
      {
        ...request(),
        preRequestScript: "throw new Error('do not execute');",
        testScript: "pw.test('test')",
        settings: { followRedirects: false },
        auth: { authType: "aws-signature", authActive: true },
      },
    ];
    const result = convert(c);
    const item = result.items[0];
    if (item.kind !== "collection") throw new Error("Expected collection");
    const rows = item.root.children as RequestNode[];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      url: "https://example.test/old",
      auth: { type: "bearer", bearer: { token: "token" } },
      body: { mode: "raw", raw: '{"old":true}' },
    });
    expect(rows[1]).toMatchObject({
      auth: { type: "apikey", apikey: { in: "query" } },
      body: { mode: "formdata", formdata: [{ enabled: false }] },
    });
    expect(rows[2]).toMatchObject({
      method: "POST",
      body: { mode: "graphql", graphql: { query: "{ hello }" } },
    });
    expect(rows[3]).toMatchObject({ auth: { type: "none" }, preRequestScript: "", testScript: "" });
    expect(result.warnings.join(" ")).toMatch(/scripts.*settings.*authentication/);
  });
  it("rejects uncaptured multipart files and excessive nesting without partial conversion", () => {
    const c = collection();
    c.requests = [
      {
        ...request(),
        body: {
          contentType: "multipart/form-data",
          body: [{ key: "file", isFile: true, value: [null], active: true }],
        },
      },
    ];
    expect(() => convert(c)).toThrow(/file uploads/);
    const root = collection();
    let cursor = root;
    for (let i = 0; i < 55; i++) {
      const child = collection();
      cursor.folders = [child];
      cursor = child;
    }
    expect(() => convert(root)).toThrow(/nesting/);
  });
  it("forwards user consent and resets it on manual dialog close", async () => {
    const bodies: Record<string, unknown>[] = [];
    const controller = createImportController(
      {
        getWorkspaceId: () => "ws",
        refreshTree: async () => {},
        refreshEnvironments: async () => {},
        refreshVariables: async () => {},
        openDraft: () => {},
        setDialogOpen: () => {},
        toastImpl: { success: () => {}, error: () => {} },
        fetchImpl: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ kind: "collection", name: "Fixture", requests: 1 }), {
            status: 201,
          });
        },
      },
      { text: "export", open: true },
    );
    controller.setIncludeCredentials(true);
    await controller.importText();
    expect(bodies[0].includeCredentials).toBe(true);
    expect(controller.getState().includeCredentials).toBe(false);
    controller.handleOpenChange(false);
    expect(controller.getState().includeCredentials).toBe(false);
  });
});
