import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";
import {
  exportPostmanCollection,
  importPostmanCollection,
  type PostmanCollection,
} from "@/core/convert/postman";
import { isPostmanV3, postmanV21ToV3, postmanV3ToV21 } from "@/core/convert/postman-v3";
import type { FolderNode, TreeNode } from "@/core/types";

const fixtures = path.join(process.cwd(), "tests", "fixtures", "postman-v3");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
const schema = read("collection.schema.json");
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
/** The official Postman v3.0.0 JSON Schema (draft-07), copied unchanged into the fixtures. */
const conforms = (document: unknown) => {
  const ok = validate(document);
  return {
    ok,
    errors: ok ? [] : (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath} ${e.message}`),
  };
};

/** Imported trees get random ids; drop them so two trees can be compared. */
const strip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, inner) =>
    key === "id" || key === "createdAt" ? undefined : inner,
  );
const find = (node: FolderNode, ...names: string[]): TreeNode => {
  let current: TreeNode = node;
  for (const name of names) {
    if (current.kind !== "folder") throw new Error(`not a folder at ${name}`);
    const next: TreeNode | undefined = current.children.find((child) => child.name === name);
    if (!next) throw new Error(`missing ${name}`);
    current = next;
  }
  return current;
};
const request = (node: FolderNode, ...names: string[]) => {
  const found = find(node, ...names);
  if (found.kind !== "request") throw new Error("not a request");
  return found;
};

const v3 = read("orders.collection.json");

describe("fixtures", () => {
  it("the Orders fixture is a valid Postman v3 collection per the official schema", () => {
    expect(conforms(v3)).toEqual({ ok: true, errors: [] });
  });

  it("the schema rejects what it should, so the check is meaningful", () => {
    expect(conforms({ name: "x" }).ok).toBe(false);
    expect(conforms({ ...v3, surprise: true }).ok).toBe(false);
    expect(
      conforms({ $kind: "collection", name: "x", items: [{ $kind: "http-request", name: "r", method: 5 }] })
        .ok,
    ).toBe(false);
  });
});

describe("detecting v3", () => {
  it("tells v3 from v2.x and other JSON", () => {
    expect(isPostmanV3(v3)).toBe(true);
    expect(isPostmanV3({ info: { name: "x" }, item: [] })).toBe(false);
    expect(isPostmanV3({ $kind: "collection", name: "x", info: {} })).toBe(false);
    expect(isPostmanV3({ name: "x" })).toBe(false);
    expect(isPostmanV3(null)).toBe(false);
    expect(isPostmanV3("collection")).toBe(false);
  });

  it("throws a clear error for non-v3 input", () => {
    expect(() => postmanV3ToV21({ name: "x" })).toThrow(/Not a Postman v3 collection/);
  });
});

describe("importing v3", () => {
  const { collection, diagnostics } = postmanV3ToV21(v3);
  const { root, variables } = importPostmanCollection(collection);

  it("keeps the collection name, description, variables and secret flag", () => {
    expect(root.name).toBe("Orders API");
    expect(root.description).toBe("Orders service.\n\nUsed by the checkout flow.");
    expect(variables).toEqual([
      { key: "baseUrl", value: "https://api.example.test", enabled: true, type: "default" },
      { key: "legacy", value: "off", enabled: false, type: "default" },
      { key: "apiToken", value: "", enabled: true, type: "secret" },
    ]);
  });

  it("keeps scripts and auth at every level, and inheritance", () => {
    expect(root.preRequestScript).toBe("pm.variables.set('started', Date.now());");
    expect(root.testScript).toContain("responseTime");
    expect(root.auth).toEqual({ type: "bearer", bearer: { token: "{{apiToken}}" } });
    const orders = find(root, "Orders") as FolderNode;
    expect(orders.preRequestScript).toBe("console.log('orders');\nconsole.log('folder');");
    expect(orders.auth).toEqual({ type: "none" });
    expect((find(root, "Uploads") as FolderNode).auth).toEqual({ type: "inherit" });
    const list = request(root, "Orders", "List orders");
    expect(list.auth).toEqual({ type: "inherit" });
    expect(list.testScript).toContain("to.have.status(200)");
    const create = request(root, "Orders", "Create order");
    expect(create.auth).toEqual({
      type: "apikey",
      apikey: { key: "X-Api-Key", value: "{{apiToken}}", in: "header" },
    });
    expect(create.preRequestScript).toBe("pm.variables.set('sku', 'A-1');");
  });

  it("keeps methods, URLs, query parameters (including disabled ones), headers and path variables", () => {
    const list = request(root, "Orders", "List orders");
    expect(list.method).toBe("GET");
    expect(list.url).toBe("{{baseUrl}}/orders?status=open&limit=50");
    expect(list.params).toEqual([
      { key: "status", value: "open", enabled: true },
      { key: "limit", value: "50", enabled: true },
      { key: "expand", value: "items", enabled: false },
    ]);
    expect(list.headers).toEqual([
      { key: "Accept", value: "application/json", enabled: true },
      { key: "X-Debug", value: "1", enabled: false },
    ]);
    expect(request(root, "Orders", "Get order").url).toBe("{{baseUrl}}/orders/42");
  });

  it("keeps every body type", () => {
    expect(request(root, "Orders", "Create order").body).toEqual({
      mode: "raw",
      raw: '{"sku":"A-1","qty":2}',
      language: "json",
    });
    expect(request(root, "Uploads", "Login form").body).toMatchObject({
      mode: "urlencoded",
      urlencoded: [
        { key: "user", value: "ada", enabled: true },
        { key: "remember", value: "1", enabled: false },
      ],
    });
    const form = request(root, "Uploads", "Upload form").body;
    expect(form.mode).toBe("formdata");
    if (form.mode === "formdata") {
      expect(form.formdata).toHaveLength(3);
      expect(form.formdata[1]).toMatchObject({
        key: "file",
        type: "file",
        fileName: "invoice.pdf",
        contentType: "application/pdf",
      });
      expect(form.formdata[2]).toMatchObject({ key: "draft", enabled: false });
    }
    expect(request(root, "Uploads", "Search").body).toEqual({
      mode: "graphql",
      graphql: { query: "query { orders { id } }", variables: "{}", operationName: "Orders" },
    });
  });

  it("keeps examples with their request and response", () => {
    const [example] = request(root, "Orders", "List orders").examples ?? [];
    expect(example).toMatchObject({
      name: "Two orders",
      status: 200,
      statusText: "OK",
      body: '[{"id":1},{"id":2}]',
      headers: [{ key: "Content-Type", value: "application/json" }],
    });
    expect(example.originalRequest?.url).toContain("{{baseUrl}}/orders");
  });

  it("reports what it could not keep", () => {
    expect(diagnostics.map((entry) => `${entry.level}: ${entry.path}: ${entry.message}`)).toEqual([
      'lossy: Orders API: Secret variable "apiToken" has no value in the file; it is imported empty',
    ]);
  });
});

describe("unsupported content is previewed, never silently dropped", () => {
  const document = {
    $kind: "collection",
    name: "Mixed",
    uses: { environment: ["env-1"] },
    scripts: [{ type: "graphql:beforeQuery", code: "x", language: "text/javascript" }],
    auth: [
      {
        id: "a",
        name: "A",
        type: "bearer",
        rules: [{ key: "url", value: "https://a.test" }],
        credentials: [{ key: "token", value: "t1" }],
      },
      {
        id: "b",
        name: "B",
        type: "bearer",
        rules: [{ key: "url", value: "https://b.test" }],
        credentials: [{ key: "token", value: "t2" }],
      },
    ],
    variables: [{ key: "vault", secret: true, source: { provider: "aws", aws: { secretArn: "arn:aws:x" } } }],
    items: [
      { $kind: "grpc-request", name: "Call" },
      { $kind: "websocket-request", name: "Socket" },
      {
        $kind: "collection",
        name: "Folder",
        items: [
          { $kind: "kafka-request", name: "Topic" },
          {
            $kind: "http-request",
            name: "Keep",
            url: "https://x.test",
            method: "GET",
            settings: { strictSSL: false, followRedirects: false, maxRedirects: 3 },
            auth: { type: "ntlm-nope", credentials: [] },
          },
        ],
      },
    ],
  };

  it("lists skipped items, script types, settings, auth rules and secret sources with their location", () => {
    expect(conforms({ ...document, auth: undefined, items: [document.items[2]] }).errors).toBeDefined();
    const result = postmanV3ToV21(document);
    const text = result.diagnostics.map((entry) => `${entry.level}|${entry.path}|${entry.message}`);
    expect(text).toContain("unsupported|Mixed / Call|gRPC request is not supported and was skipped");
    expect(text).toContain("unsupported|Mixed / Socket|WebSocket request is not supported and was skipped");
    expect(text).toContain(
      "unsupported|Mixed / Folder / Topic|Kafka request is not supported and was skipped",
    );
    expect(text).toContain(
      'unsupported|Mixed|Script type "graphql:beforeQuery" is not supported and was skipped',
    );
    expect(text).toContain(
      "lossy|Mixed|Several credential sets with URL rules are not supported; the first one is used",
    );
    expect(text).toContain(
      "lossy|Mixed|Environment references (uses) are not imported; import the environments separately",
    );
    expect(
      text.some((line) =>
        line.includes("Request settings are not imported (strictSSL, followRedirects, maxRedirects)"),
      ),
    ).toBe(true);
    expect(text.some((line) => line.includes('Secret variable "vault" (from aws)'))).toBe(true);
    expect(text.some((line) => line.includes('Authentication type "ntlm-nope" is not supported'))).toBe(true);
    // Skipped items do not appear in the imported tree; the rest does.
    const { root } = importPostmanCollection(result.collection);
    expect(root.children.map((child) => child.name)).toEqual(["Folder"]);
    expect(root.auth).toEqual({ type: "bearer", bearer: { token: "t1" } });
  });
});

describe("exporting v3", () => {
  const { root, variables } = importPostmanCollection(postmanV3ToV21(v3).collection);
  const exported = postmanV21ToV3(exportPostmanCollection(root, variables, { includeCredentials: true }));

  it("writes a document the official v3 schema accepts", () => {
    expect(conforms(exported.collection)).toEqual({ ok: true, errors: [] });
  });

  it("preserves scripts, auth, examples, typed metadata, bodies and query state", () => {
    const doc = exported.collection as {
      items: { items: Record<string, unknown>[] }[];
      scripts: unknown[];
      auth: unknown;
    };
    expect(doc.scripts).toEqual([
      {
        type: "http:beforeRequest",
        code: "pm.variables.set('started', Date.now());",
        language: "text/javascript",
      },
      {
        type: "http:afterResponse",
        code: expect.stringContaining("responseTime"),
        language: "text/javascript",
      },
    ]);
    expect(doc.auth).toEqual({ type: "bearer", credentials: [{ key: "token", value: "{{apiToken}}" }] });
    const list = doc.items[0].items[0] as Record<string, unknown>;
    expect(list).toMatchObject({
      $kind: "http-request",
      name: "List orders",
      url: "{{baseUrl}}/orders",
      queryParams: [
        { key: "status", value: "open" },
        { key: "limit", value: "50" },
        { key: "expand", value: "items", disabled: true },
      ],
      headers: [
        { key: "Accept", value: "application/json", $type: "text" },
        { key: "X-Debug", value: "1", $type: "text", disabled: true },
      ],
    });
    expect((list.examples as { response: { body: { type: string } } }[])[0].response.body.type).toBe("json");
  });

  it("says what v3 cannot hold", () => {
    expect(exported.diagnostics).toEqual([
      {
        level: "lossy",
        path: "Orders API",
        message: 'Secret variable "apiToken" is exported without a value, as v3 cannot hold one',
      },
    ]);
  });

  it("never writes the value of a secret variable", () => {
    const doc = postmanV21ToV3(
      exportPostmanCollection(
        root,
        [
          ...variables.filter((v) => v.type !== "secret"),
          { key: "k", value: "super-secret-value", enabled: true, type: "secret" },
        ],
        {
          includeSecrets: true,
        },
      ),
    );
    expect(JSON.stringify(doc.collection)).not.toContain("super-secret-value");
  });
});

describe("round trips and migration", () => {
  it("v3 -> Postbox -> v3 -> Postbox gives the same collection", () => {
    const first = importPostmanCollection(postmanV3ToV21(v3).collection);
    const out = postmanV21ToV3(
      exportPostmanCollection(first.root, first.variables, { includeCredentials: true }),
    );
    const second = importPostmanCollection(postmanV3ToV21(out.collection).collection);
    expect(strip(second.root)).toEqual(strip(first.root));
    expect(second.variables).toEqual(first.variables);
  });

  it("v3 -> Postbox -> v3 is stable after the first export", () => {
    const first = importPostmanCollection(postmanV3ToV21(v3).collection);
    const once = postmanV21ToV3(
      exportPostmanCollection(first.root, first.variables, { includeCredentials: true }),
    ).collection;
    const again = importPostmanCollection(postmanV3ToV21(once).collection);
    const twice = postmanV21ToV3(
      exportPostmanCollection(again.root, again.variables, { includeCredentials: true }),
    ).collection;
    expect(strip(twice)).toEqual(strip(once));
  });

  it("migrates a v2.1 collection to v3 and imports it identically", () => {
    const v21: PostmanCollection = {
      info: {
        name: "Legacy",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      auth: {
        type: "basic",
        basic: [
          { key: "username", value: "u", type: "string" },
          { key: "password", value: "p", type: "string" },
        ],
      },
      event: [{ listen: "prerequest", script: { exec: ["a();", "b();"] } }],
      variable: [{ key: "host", value: "h.test" }],
      item: [
        {
          name: "Folder",
          event: [{ listen: "test", script: { exec: "pm.test('x', () => {});" } }],
          item: [
            {
              name: "One",
              request: {
                method: "PUT",
                url: {
                  raw: "https://h.test/a/:id?x=1",
                  host: ["h", "test"],
                  path: ["a", ":id"],
                  query: [
                    { key: "x", value: "1" },
                    { key: "y", value: "2", disabled: true },
                  ],
                  variable: [{ key: "id", value: "7" }],
                },
                header: [{ key: "K", value: "V", type: "text" }],
                body: { mode: "raw", raw: "<a/>", options: { raw: { language: "xml" } } },
                auth: {
                  type: "bearer",
                  bearer: [{ key: "token", value: "token-long-value", type: "string" }],
                },
              },
              response: [
                {
                  name: "ok",
                  code: 201,
                  status: "Created",
                  header: [{ key: "Content-Type", value: "application/xml" }],
                  body: "<ok/>",
                },
              ],
            },
          ],
        },
      ],
    };
    const migrated = postmanV21ToV3(v21);
    expect(conforms(migrated.collection)).toEqual({ ok: true, errors: [] });
    expect(migrated.diagnostics).toEqual([]);
    const fromV21 = importPostmanCollection(v21);
    const fromV3 = importPostmanCollection(postmanV3ToV21(migrated.collection).collection);
    // The v3 route resolves `:id` in the URL itself and splits the query, which v2.1 imports do not; compare the parts that must match.
    const a = request(fromV21.root, "Folder", "One");
    const b = request(fromV3.root, "Folder", "One");
    expect(b).toMatchObject({
      method: "PUT",
      body: a.body,
      auth: a.auth,
      headers: a.headers,
      params: a.params,
    });
    expect(b.examples?.[0]).toMatchObject({ name: "ok", status: 201, statusText: "Created", body: "<ok/>" });
    expect(fromV3.root.preRequestScript).toBe(fromV21.root.preRequestScript);
    expect((find(fromV3.root, "Folder") as FolderNode).testScript).toBe("pm.test('x', () => {});");
    expect(fromV3.variables).toEqual(fromV21.variables);
  });

  it("keeps v2.1 import behaviour unchanged", () => {
    const v21 = {
      info: { name: "Plain" },
      item: [{ name: "r", request: { method: "GET", url: "https://x.test" } }],
    };
    expect(isPostmanV3(v21)).toBe(false);
    expect(importPostmanCollection(v21 as PostmanCollection).root.children).toHaveLength(1);
  });
});

describe("hostile input", () => {
  it("handles deep nesting, odd keys and wrong types without throwing", () => {
    let node: Record<string, unknown> = {
      $kind: "http-request",
      name: "leaf",
      url: "https://x.test",
      method: "GET",
    };
    for (let i = 0; i < 300; i++) node = { $kind: "collection", name: `f${i}`, items: [node] };
    expect(() => importPostmanCollection(postmanV3ToV21({ ...node, name: "Deep" }).collection)).not.toThrow();
    const weird = postmanV3ToV21({
      $kind: "collection",
      name: "Weird",
      auth: {
        type: "apikey",
        credentials: [
          { key: "__proto__", value: "x" },
          { key: "key", value: 5 },
          { key: "constructor", value: { a: 1 } },
        ],
      },
      variables: [null, 5, "x", { key: 1, value: { nested: true } }],
      items: [
        null,
        7,
        "str",
        { $kind: "http-request" },
        {
          $kind: "http-request",
          name: 9,
          url: 3,
          headers: "no",
          queryParams: [null, { key: null, value: null }],
          body: { type: "nope" },
          examples: [{}],
        },
      ],
    });
    const { root } = importPostmanCollection(weird.collection);
    expect(root.children.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not execute or evaluate script content", () => {
    const marker = "globalThis.__v3_pwned = true";
    const { collection } = postmanV3ToV21({
      $kind: "collection",
      name: "Scripts",
      scripts: [{ type: "http:beforeRequest", code: marker }],
      items: [],
    });
    importPostmanCollection(collection);
    expect((globalThis as Record<string, unknown>).__v3_pwned).toBeUndefined();
  });
});
