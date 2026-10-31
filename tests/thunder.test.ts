import { describe, expect, it } from "vitest";
import { importThunderClient, isThunderClient } from "@/core/convert/thunder";
import { Resolver, emptyScopes, variablesToRecord } from "@/core/variables/resolver";
import { prepareRequest } from "@/core/http/prepare";
import type { FolderNode, RequestNode } from "@/core/types";

const request = (id: string, folder = "") => ({
  _id: id,
  containerId: folder,
  name: id,
  method: "POST",
  url: "/users/{id}?q=one&q=two&off=no#fragment",
  sortNum: 10,
  params: [
    { name: "id", value: "a/b", isPath: true },
    { name: "q", value: "one" },
    { name: "q", value: "two" },
    { name: "off", value: "no", isDisabled: true },
  ],
  headers: [
    { name: "X-Local", value: "yes" },
    { name: "X-Inherit", value: "disabled", isDisabled: true },
  ],
  body: { type: "json", raw: '{"value":"{{value}}"}', form: [] },
});
const collection = () => ({
  clientName: "Thunder Client",
  version: "1.2",
  collectionName: "Fixture",
  folders: [] as unknown[],
  requests: [request("root")] as unknown[],
  variables: [{ name: "value", value: "resolved" }],
  settings: {
    auth: { type: "basic", basic: { username: "user", password: "password" } },
    headers: [{ name: "X-Inherit", value: "outer" }],
    options: { baseUrl: "https://example.test/api/" },
  },
});
const convert = (source: unknown) => importThunderClient(source, { includeCredentials: true });

describe("Thunder Client migration", () => {
  it("recognizes native marker/version variants and requires explicit credential consent", () => {
    expect(isThunderClient(collection())).toBe(true);
    expect(isThunderClient({ client: "Thunder Client" })).toBe(true);
    expect(isThunderClient({ client: {} })).toBe(false);
    expect(() => importThunderClient(collection())).toThrow(/includeCredentials/);
    for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4"])
      expect(convert({ ...collection(), version }).kind).toBe("collection");
    expect(() => convert({ ...collection(), version: "9.0" })).toThrow(/version/);
  });
  it("maps nested hierarchy and combined sibling order with inherited auth, headers and base URL", async () => {
    const source = collection();
    source.folders = [{ _id: "folder", name: "Nested", containerId: "", sortNum: 5 }];
    source.requests = [
      request("second", "folder"),
      { ...request("first", "folder"), sortNum: 1 },
      request("root"),
    ];
    const item = convert(source);
    if (item.kind !== "collection") throw new Error("Expected collection");
    const folder = item.root.children[0] as FolderNode;
    expect(folder.name).toBe("Nested");
    expect(folder.children.map((r) => r.name)).toEqual(["first", "second"]);
    expect(item.root.children[1].name).toBe("root");
    const r = folder.children[0] as RequestNode;
    const prepared = await prepareRequest(
      r,
      [item.root, folder],
      new Resolver({ ...emptyScopes(), collection: variablesToRecord(item.variables) }),
      undefined,
      { offline: true },
    );
    expect(prepared.prepared.url).toBe("https://example.test/api/users/a%2Fb?q=one&q=two#fragment");
    expect(prepared.prepared.headers).toContainEqual(["X-Inherit", "outer"]);
    expect(prepared.prepared.headers).toContainEqual(["X-Local", "yes"]);
    expect(prepared.prepared.headers).toContainEqual([
      "Authorization",
      "Basic " + Buffer.from("user:password").toString("base64"),
    ]);
    expect(prepared.prepared.body?.toString()).toBe('{"value":"resolved"}');
    expect(r.params.filter((p) => p.enabled && p.key === "q")).toHaveLength(2);
    expect(r.params.find((p) => p.key === "off")?.enabled).toBe(false);
    expect(r.settings.useCookieJar).toBe(false);
  });
  it("maps environment values with secret/disabled flags", () => {
    expect(
      convert({
        client: "Thunder Client",
        version: "1.0",
        environmentName: "Environment",
        variables: [
          { name: "secret", value: "credential", isSecret: true },
          { name: "off", value: "old", isDisabled: true },
        ],
      }),
    ).toMatchObject({
      kind: "environment",
      name: "Environment",
      variables: [
        { key: "secret", value: "credential", type: "secret" },
        { key: "off", enabled: false },
      ],
    });
  });
  it("maps all native body modes, line-array docs, bearer/API key/none overrides and diagnoses source tests", () => {
    const source = collection();
    source.requests = [
      {
        ...request("xml"),
        params: [],
        body: { type: "xml", raw: ["<root>", "</root>"] },
        docs: ["First line", "Second line"],
        auth: { type: "none" },
      },
      {
        ...request("form"),
        params: [],
        body: {
          type: "formencoded",
          form: [
            { name: "x", value: "one" },
            { name: "off", value: "no", isDisabled: true },
          ],
        },
        auth: { type: "bearer", bearer: "token" },
      },
      {
        ...request("multipart"),
        params: [],
        body: { type: "formdata", form: [{ name: "field", value: "text" }] },
      },
      {
        ...request("graphql"),
        params: [],
        body: { type: "graphql", graphql: { query: "{ hello }", variables: "{}" } },
        auth: { type: "apikey", apikey: { name: "key", value: "token", in: "query" } },
        tests: [{ type: "status", value: 200 }],
        scripts: { preRequest: "throw new Error('no');" },
      },
      { ...request("binary"), params: [], body: { type: "binary" }, auth: { type: "ntlm" } },
    ];
    const item = convert(source);
    if (item.kind !== "collection") throw new Error("Expected collection");
    const rows = item.root.children as RequestNode[];
    expect(rows[0]).toMatchObject({
      body: { mode: "raw", language: "xml", raw: "<root>\n</root>" },
      description: "First line\nSecond line",
      auth: { type: "none" },
    });
    expect(rows[1]).toMatchObject({
      body: { mode: "urlencoded", urlencoded: [{ value: "one" }, { enabled: false }] },
      auth: { type: "bearer", bearer: { token: "token" } },
    });
    expect(rows[2].body.mode).toBe("formdata");
    expect(rows[3]).toMatchObject({
      body: { mode: "graphql", graphql: { query: "{ hello }" } },
      auth: { type: "apikey", apikey: { in: "query" } },
      preRequestScript: "",
      testScript: "",
    });
    expect(rows[4]).toMatchObject({ body: { mode: "binary", binary: null }, auth: { type: "none" } });
    expect(item.warnings.join(" ")).toMatch(/tests\/scripts.*Binary.*authentication/);
  });
  it("reports legacy string and array scripts without attempting to execute or parse them", () => {
    const source = collection();
    source.requests = [
      { ...request("Scripted"), tests: "tc.test('legacy')", scripts: ["throw new Error('never');"] },
    ];
    const item = convert(source);
    if (item.kind !== "collection") throw new Error("Expected collection");
    expect(item.warnings.join(" ")).toContain("tests/scripts were not translated");
    expect(item.root.children[0]).toMatchObject({ preRequestScript: "", testScript: "" });
  });
  it("rejects cycles, missing/duplicate/conflicting folder links and missing file bytes", () => {
    const s = collection();
    s.folders = [
      { _id: "a", name: "A", containerId: "b" },
      { _id: "b", name: "B", containerId: "a" },
    ];
    expect(() => convert(s)).toThrow(/cycle/);
    s.folders = [{ _id: "a", name: "A", containerId: "missing" }];
    expect(() => convert(s)).toThrow(/missing folder/);
    s.folders = [
      { _id: "a", name: "A" },
      { _id: "a", name: "Duplicate" },
    ];
    expect(() => convert(s)).toThrow(/Duplicate/);
    s.folders = [
      { _id: "a", name: "A" },
      { _id: "b", name: "B", containerId: "a", parentId: "b" },
    ];
    expect(() => convert(s)).toThrow(/Conflicting/);
    s.folders = [];
    s.requests = [
      { ...request("upload"), body: { type: "formdata", files: [{ name: "file", value: "local.txt" }] } },
    ];
    expect(() => convert(s)).toThrow(/file bytes/);
  });
});
