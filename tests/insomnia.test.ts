import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importInsomnia, isInsomnia } from "@/core/convert/insomnia";
import { parseSpec } from "@/core/convert/openapi";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import type { FolderNode, RequestNode } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-insomnia-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) =>
  parseSpec(fs.readFileSync(path.join(__dirname, "fixtures/insomnia", name), "utf8"));
const v4 = () => importInsomnia(fixture("v4-export.json"), { includeCredentials: true });
const v5 = () => importInsomnia(fixture("v5-collection.yaml"), { includeCredentials: true });
const find = (node: FolderNode, name: string): RequestNode | FolderNode => {
  for (const child of node.children) {
    if (child.name === name) return child;
    if (child.kind === "folder") {
      try {
        return find(child, name);
      } catch {
        // keep searching siblings
      }
    }
  }
  throw new Error(`missing ${name}`);
};

describe("Insomnia detection and consent", () => {
  it("detects v4 and v5 exports only", () => {
    expect(isInsomnia(fixture("v4-export.json"))).toBe(true);
    expect(isInsomnia(fixture("v5-collection.yaml"))).toBe(true);
    expect(isInsomnia({ info: { name: "postman" }, item: [] })).toBe(false);
  });

  it("requires explicit credential consent and a supported format", () => {
    expect(() => importInsomnia(fixture("v4-export.json"))).toThrow(/includeCredentials/);
    expect(() =>
      importInsomnia({ _type: "export", __export_format: 3, resources: [] }, { includeCredentials: true }),
    ).toThrow(/format 3/);
  });
});

describe("Insomnia v4 export", () => {
  it("maps the resource tree in sort order", () => {
    const { collections } = v4();
    expect(collections).toHaveLength(1);
    const root = collections[0].root;
    expect(root.name).toBe("Shop API");
    expect(root.description).toBe("Shop endpoints");
    expect(root.children.map((c) => c.name)).toEqual(["Login", "Products query", "Users"]);
    expect((find(root, "Users") as FolderNode).children.map((c) => c.name)).toEqual([
      "List users",
      "Create user",
      "Upload avatar",
    ]);
  });

  it("turns the base environment into collection variables and sub-environments into environments", () => {
    const { collections, environments } = v4();
    expect(collections[0].variables).toEqual([
      { key: "base_url", value: "https://api.shop.test", type: "default", enabled: true },
      { key: "auth.token", value: "base-token", type: "default", enabled: true },
    ]);
    expect(environments.map((e) => e.name)).toEqual(["Production", "Development"]);
    expect(environments[1].variables).toContainEqual({
      key: "retries",
      value: "3",
      type: "default",
      enabled: true,
    });
  });

  it("converts folder environments, auth, headers and query parameters", async () => {
    const root = v4().collections[0].root;
    const users = find(root, "Users") as FolderNode;
    expect(users.auth).toEqual({ type: "bearer", bearer: { token: "{{auth.token}}" } });
    expect(users.headers).toEqual([{ key: "X-Team", value: "users", enabled: true }]);
    expect(users.preRequestScript).toContain('pm.variables.set("page_size", "50");');

    const list = find(root, "List users") as RequestNode;
    expect(list.url).toBe("{{base_url}}/users?limit={{page_size}}");
    expect(list.params).toEqual([
      { key: "limit", value: "{{page_size}}", enabled: true },
      { key: "debug", value: "1", enabled: false },
    ]);
    expect(list.auth).toEqual({ type: "inherit" });
    expect(list.settings).toMatchObject({ followRedirects: false, useCookieJar: false });

    const prepared = await prepareRequest(
      list,
      [root, users],
      new Resolver({ ...emptyScopes(), collection: { base_url: "https://api.shop.test", page_size: "50" } }),
      undefined,
      { offline: true },
    );
    expect(prepared.prepared.url).toBe("https://api.shop.test/users?limit=50");
  });

  it("maps bodies, keeps plugins unresolved and comments out scripts", () => {
    const { collections, warnings } = v4();
    const root = collections[0].root;
    const create = find(root, "Create user") as RequestNode;
    expect(create.body).toEqual({
      mode: "raw",
      raw: '{"id": "{% uuid \'v4\' %}", "name": "{{name}}"}',
      language: "json",
    });
    expect(create.auth).toEqual({ type: "basic", basic: { username: "admin", password: "s3cret" } });
    expect(create.preRequestScript).toMatch(/^\/\/ Imported from Insomnia \(pre-request\)/);
    expect(create.preRequestScript).toContain("// insomnia.environment.set('name', 'Ada');");
    expect(create.testScript).toContain("// insomnia.test(");

    const avatar = find(root, "Upload avatar") as RequestNode;
    expect(avatar.body).toEqual({
      mode: "formdata",
      formdata: [
        { key: "caption", value: "me", enabled: true, type: "text" },
        {
          key: "file",
          value: "",
          enabled: true,
          type: "file",
          fileName: "avatar.png",
          data: "",
          missing: true,
        },
      ],
    });
    expect(avatar.auth).toMatchObject({
      type: "awsv4",
      awsv4: { accessKey: "AKID", secretKey: "SECRET", region: "eu-west-1", service: "execute-api" },
    });

    const login = find(root, "Login") as RequestNode;
    expect(login.body).toEqual({
      mode: "urlencoded",
      urlencoded: [
        { key: "user", value: "ada", enabled: true },
        { key: "pass", value: "{{password}}", enabled: true },
      ],
    });
    expect(login.auth).toMatchObject({
      type: "oauth2",
      oauth2: { grantType: "authorization_code", clientSecret: "csec", usePkce: false },
    });

    const gql = find(root, "Products query") as RequestNode;
    expect(gql.body).toEqual({
      mode: "graphql",
      graphql: { query: "query { products { id } }", variables: '{\n  "first": 10\n}' },
    });
    expect(gql.auth).toEqual({ type: "apikey", apikey: { key: "X-Api-Key", value: "k123", in: "header" } });

    expect(warnings).toEqual(
      expect.arrayContaining([
        'Template tag "uuid" is an Insomnia plugin feature and was left unresolved.',
        "Insomnia cookie_jar resources are not migrated.",
        "Insomnia api_spec resources are not migrated.",
        '"Orphan" references a missing parent folder and was skipped.',
        'websocket_request items are not supported yet and were skipped (for example "Live feed").',
        "Upload avatar: form-data file contents are not part of Insomnia exports; reselect the files.",
        "Users: folder environment variables were converted to a folder pre-request script.",
      ]),
    );
  });

  it("rejects duplicate IDs and invalid methods", () => {
    const dup = {
      _type: "export",
      __export_format: 4,
      resources: [
        { _id: "wrk", _type: "workspace", name: "w" },
        { _id: "wrk", _type: "request", parentId: "wrk" },
      ],
    };
    expect(() => importInsomnia(dup, { includeCredentials: true })).toThrow(/Duplicate/);
    const bad = {
      _type: "export",
      __export_format: 4,
      resources: [
        { _id: "wrk", _type: "workspace", name: "w" },
        { _id: "r", _type: "request", parentId: "wrk", name: "r", method: "GE T", url: "x" },
      ],
    };
    expect(() => importInsomnia(bad, { includeCredentials: true })).toThrow(/invalid method/);
  });
});

describe("Insomnia v5 collection", () => {
  it("maps nested items, environments and auth", () => {
    const { collections, environments, warnings } = v5();
    const root = collections[0].root;
    expect(root.name).toBe("Billing");
    expect(root.description).toBe("Billing service");
    expect(root.children.map((c) => c.name)).toEqual(["Health", "Invoices"]);
    expect(collections[0].variables).toEqual([
      { key: "host", value: "https://billing.test", type: "default", enabled: true },
    ]);
    expect(environments).toEqual([
      {
        name: "Staging",
        variables: [{ key: "host", value: "https://billing.staging", type: "default", enabled: true }],
      },
    ]);
    const invoices = find(root, "Invoices") as FolderNode;
    expect(invoices.auth).toMatchObject({ type: "hawk", hawk: { authId: "hawk-id", authKey: "hawk-key" } });
    expect(invoices.preRequestScript).toContain('pm.variables.set("tenant", "acme");');
    const get = find(root, "Get invoices") as RequestNode;
    expect(get.url).toBe("{{host}}/invoices/{{tenant}}");
    expect(get.preRequestScript).toContain("// insomnia.variables.set('x', 1);");
    const health = find(root, "Health") as RequestNode;
    expect(health.method).toBe("GET");
    expect(health.auth).toEqual({ type: "ntlm", ntlm: { username: "CORP\\svc", password: "pw" } });
    expect(warnings).toEqual(
      expect.arrayContaining([
        "Insomnia cookie jars are not migrated.",
        'greq items are not supported yet and were skipped (for example "Invoice stream").',
        'Get invoices: "do not encode URL" was not migrated; Postbox sends URLs as written.',
      ]),
    );
  });
});

describe("Insomnia through the shared importer", () => {
  it("creates the collection and environments in one batch", async () => {
    const { importContent } = await import("@/server/importer");
    const repo = await import("@/server/repo");
    const ws = repo.createWorkspace("Insomnia");
    const content = fs.readFileSync(path.join(__dirname, "fixtures/insomnia/v4-export.json"), "utf8");
    expect(() => importContent(ws.id, content)).toThrow(/includeCredentials/);
    const outcome = importContent(ws.id, content, undefined, { includeCredentials: true });
    expect(outcome.kind).toBe("batch");
    if (outcome.kind !== "batch") return;
    expect(outcome.items.map((i) => i.kind)).toEqual(["collection", "environment", "environment"]);
    expect(outcome.items[0]).toMatchObject({ source: "insomnia", requests: 5, folders: 1 });
    expect(
      repo
        .listEnvironments(ws.id)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["Development", "Production"]);
    (await import("@/server/db")).getSqlite().close();
  });
});
