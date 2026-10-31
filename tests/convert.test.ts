import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCurl, tokenize } from "@/core/convert/curl";
import {
  exportPostmanCollection,
  importPostmanCollection,
  importPostmanEnvironment,
  exportPostmanEnvironment,
  type PostmanCollection,
} from "@/core/convert/postman";
import { importOpenApi } from "@/core/convert/openapi";
import { generateSnippet } from "@/core/convert/codegen";
import { Resolver, emptyScopes, variablesToRecord } from "@/core/variables/resolver";
import type { FolderNode, RequestNode } from "@/core/types";

describe("cURL import", () => {
  it("tokenizes quotes, escapes and line continuations", () => {
    expect(tokenize(`curl 'a b' "c \\"d\\"" e\\ f \\\n -H $'x\\ny'`)).toEqual([
      "curl",
      "a b",
      'c "d"',
      "e f",
      "-H",
      "x\ny",
    ]);
  });

  it("parses method, headers, JSON body and auth", () => {
    const r = parseCurl(
      `curl -X POST 'https://api.example.com/users?x=1' -H 'Content-Type: application/json' -H "Authorization: Bearer abc" --data-raw '{"name":"a"}' -u user:pw -k -L`,
    );
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.example.com/users?x=1");
    expect(r.headers.map((h) => h.key)).toEqual(["Content-Type", "Authorization"]);
    expect(r.body).toEqual({ mode: "raw", language: "json", raw: '{\n  "name": "a"\n}' });
    expect(r.auth).toEqual({ type: "basic", basic: { username: "user", password: "pw" } });
    expect(r.insecure).toBe(true);
  });

  it("handles form data, urlencoded data and -G", () => {
    expect(parseCurl(`curl https://x.test -F 'a=1' -F 'file=@/tmp/a.png'`).body).toMatchObject({
      mode: "formdata",
      formdata: [
        { key: "a", value: "1", type: "text" },
        { key: "file", type: "file", fileName: "/tmp/a.png" },
      ],
    });
    expect(parseCurl(`curl https://x.test -d 'a=1&b=two%20words'`).body).toEqual({
      mode: "urlencoded",
      urlencoded: [
        { key: "a", value: "1", enabled: true },
        { key: "b", value: "two words", enabled: true },
      ],
    });
    const g = parseCurl(`curl -G https://x.test/search --data-urlencode 'q=a b'`);
    expect(g.method).toBe("GET");
    expect(g.url).toBe("https://x.test/search?q=a%20b");
    expect(parseCurl("curl example.com").url).toBe("http://example.com");
  });
});

const postmanFixture: PostmanCollection = {
  info: { name: "Sample", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
  event: [{ listen: "prerequest" as const, script: { exec: ["console.log('col')"] } }],
  variable: [{ key: "baseUrl", value: "https://api.test" }],
  item: [
    {
      name: "Users",
      item: [
        {
          name: "Get user",
          event: [
            { listen: "test" as const, script: { exec: ["pm.test('ok', () => {});", "// second line"] } },
          ],
          request: {
            method: "GET",
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Off", value: "1", disabled: true },
            ],
            url: {
              raw: "{{baseUrl}}/users/:id?verbose=true",
              host: ["{{baseUrl}}"],
              path: ["users", ":id"],
              query: [
                { key: "verbose", value: "true" },
                { key: "debug", value: "1", disabled: true },
              ],
              variable: [{ key: "id", value: "" }],
            },
          },
          response: [{ name: "OK", code: 200, status: "OK", header: [], body: "{}" }],
        },
      ],
    },
    {
      name: "Create",
      request: {
        method: "POST",
        auth: { type: "noauth" },
        url: "{{baseUrl}}/users",
        body: { mode: "raw", raw: '{"a":1}', options: { raw: { language: "json" } } },
      },
    },
  ],
};

describe("Postman collections", () => {
  it("imports folders, requests, scripts, auth, variables and examples", () => {
    const { root, variables } = importPostmanCollection(postmanFixture);
    expect(root.name).toBe("Sample");
    expect(root.auth).toEqual({ type: "bearer", bearer: { token: "{{token}}" } });
    expect(root.preRequestScript).toBe("console.log('col')");
    expect(variables).toEqual([
      { key: "baseUrl", value: "https://api.test", enabled: true, type: "default" },
    ]);
    const users = root.children[0] as FolderNode;
    const get = users.children[0] as RequestNode;
    expect(get.url).toBe("{{baseUrl}}/users/{{id}}?verbose=true");
    expect(get.params).toEqual([
      { key: "verbose", value: "true", enabled: true, description: undefined },
      { key: "debug", value: "1", enabled: false, description: undefined },
    ]);
    expect(get.headers[1]).toMatchObject({ key: "X-Off", enabled: false });
    expect(get.testScript).toBe("pm.test('ok', () => {});\n// second line");
    expect(get.auth).toEqual({ type: "inherit" });
    expect(get.examples?.[0]).toMatchObject({ name: "OK", status: 200 });
    const create = root.children[1] as RequestNode;
    expect(create.auth).toEqual({ type: "none" });
    expect(create.body).toEqual({ mode: "raw", raw: '{"a":1}', language: "json" });
  });

  it("round-trips through export", () => {
    const { root, variables } = importPostmanCollection(postmanFixture);
    const exported = exportPostmanCollection(root, variables);
    expect(exported.info.schema).toContain("v2.1.0");
    const again = importPostmanCollection(exported);
    const strip = (n: FolderNode): unknown =>
      JSON.parse(JSON.stringify(n, (k, v) => (k === "id" || k === "createdAt" ? undefined : v)));
    expect(strip(again.root)).toEqual(strip(root));
    expect(again.variables).toEqual(variables);
  });

  it("imports and exports environments without secrets by default", () => {
    const env = importPostmanEnvironment({
      name: "Dev",
      values: [
        { key: "host", value: "dev", enabled: true },
        { key: "pw", value: "s3cret", type: "secret", enabled: true },
      ],
    });
    expect(env.variables[1]).toEqual({ key: "pw", value: "s3cret", enabled: true, type: "secret" });
    expect(exportPostmanEnvironment("Dev", env.variables).values[1].value).toBe("");
    expect(exportPostmanEnvironment("Dev", env.variables, { includeSecrets: true }).values[1].value).toBe(
      "s3cret",
    );
  });
});

describe("OpenAPI import", () => {
  const spec = `
openapi: 3.0.3
info: { title: Pets, version: "1" }
servers: [{ url: "https://{env}.pets.test/v1", variables: { env: { default: api } } }]
security: [{ bearerAuth: [] }]
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        id: { type: integer, example: 7 }
        name: { type: string }
        tags: { type: array, items: { type: string } }
paths:
  /pets:
    get:
      tags: [pets]
      summary: List pets
      parameters:
        - { name: limit, in: query, required: true, schema: { type: integer, default: 20 } }
        - { name: cursor, in: query, schema: { type: string } }
    post:
      tags: [pets]
      summary: Create pet
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Pet" }
  /pets/{petId}:
    parameters: [{ name: petId, in: path, required: true, schema: { type: string } }]
    delete:
      operationId: deletePet
      security: []
`;
  it("creates folders per tag, requests, bodies, auth and baseUrl", () => {
    const { root, variables } = importOpenApi(spec);
    expect(root.name).toBe("Pets");
    expect(root.auth).toEqual({ type: "bearer", bearer: { token: "{{token}}" } });
    expect(variables).toEqual([
      { key: "baseUrl", value: "https://api.pets.test/v1", type: "default", enabled: true },
      { key: "petId", value: "", type: "default", enabled: true },
    ]);
    const pets = root.children.find((c) => c.name === "pets") as FolderNode;
    const list = pets.children[0] as RequestNode;
    expect(list).toMatchObject({ name: "List pets", method: "GET", url: "{{baseUrl}}/pets?limit=20" });
    expect(list.params.map((p) => [p.key, p.enabled])).toEqual([
      ["limit", true],
      ["cursor", false],
    ]);
    const create = pets.children[1] as RequestNode;
    expect(create.body.mode).toBe("raw");
    expect(JSON.parse((create.body as { raw: string }).raw)).toEqual({
      id: 7,
      name: "string",
      tags: ["string"],
    });
    const del = root.children.find((c) => c.name === "deletePet") as RequestNode;
    const rel = importOpenApi(
      { openapi: "3.0.0", info: { title: "R" }, servers: [{ url: "/api/v3" }], paths: {} },
      { sourceUrl: "https://pets.test/api/v3/openapi.json" },
    );
    expect(rel.variables[0].value).toBe("https://pets.test/api/v3");
    expect(
      importOpenApi({ openapi: "3.0.0", info: { title: "R" }, servers: [{ url: "/v1" }], paths: {} })
        .variables[0].value,
    ).toBe("http://localhost/v1");
    expect(del).toMatchObject({
      method: "DELETE",
      url: "{{baseUrl}}/pets/{{petId}}",
      auth: { type: "none" },
    });
  });

  it("honors operation > path > root server precedence across multiple hosts", () => {
    const { root, variables } = importOpenApi({
      openapi: "3.0.3",
      info: { title: "MultiHost", version: "1.0.0" },
      servers: [
        { url: "https://root.test/v1/" },
        { url: "https://root-backup.test/v1" },
      ],
      paths: {
        "/root-default": {
          get: { operationId: "getRootDefault" },
        },
        "/orders": {
          servers: [
            { url: "https://orders.test/api/" },
            { url: "https://orders-secondary.test/api" },
          ],
          get: {
            operationId: "listOrders",
            // Empty servers array should fall back to path server.
            servers: [],
          },
          post: {
            operationId: "createOrder",
            servers: [{ url: "https://write-orders.test/v2/" }],
          },
          delete: {
            operationId: "purgeOrders",
            // Reuses the same override URL to verify variable deduplication.
            servers: [{ url: "https://write-orders.test/v2" }],
          },
        },
      },
    });

    expect(variables).toEqual([
      { key: "baseUrl", value: "https://root.test/v1", type: "default", enabled: true },
      { key: "baseUrl_2", value: "https://orders.test/api", type: "default", enabled: true },
      { key: "baseUrl_3", value: "https://write-orders.test/v2", type: "default", enabled: true },
    ]);

    const requests = Object.fromEntries(
      (root.children as RequestNode[]).map((r) => [r.name, r]),
    );
    expect(requests.getRootDefault.url).toBe("{{baseUrl}}/root-default");
    expect(requests.listOrders.url).toBe("{{baseUrl_2}}/orders");
    expect(requests.createOrder.url).toBe("{{baseUrl_3}}/orders");
    expect(requests.purgeOrders.url).toBe("{{baseUrl_3}}/orders");

    const resolver = new Resolver({
      ...emptyScopes(),
      collection: variablesToRecord(variables),
    });
    expect(resolver.resolve(requests.getRootDefault.url)).toBe(
      "https://root.test/v1/root-default",
    );
    expect(resolver.resolve(requests.listOrders.url)).toBe(
      "https://orders.test/api/orders",
    );
    expect(resolver.resolve(requests.createOrder.url)).toBe(
      "https://write-orders.test/v2/orders",
    );
  });

  it("resolves relative path and operation server URLs against sourceUrl or root server", () => {
    const specWithRelativeOverrides = {
      openapi: "3.0.3",
      info: { title: "RelativeOverrides", version: "1.0.0" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/items": {
          servers: [{ url: "/v2" }],
          get: { operationId: "listItemsV2" },
          post: {
            operationId: "createItemAdmin",
            servers: [{ url: "/admin/v3/" }],
          },
        },
      },
    };

    // Without sourceUrl, relative overrides resolve against the root server's origin.
    const withoutSource = importOpenApi(specWithRelativeOverrides);
    expect(withoutSource.variables).toEqual([
      { key: "baseUrl", value: "https://api.example.com/v1", type: "default", enabled: true },
      { key: "baseUrl_2", value: "https://api.example.com/v2", type: "default", enabled: true },
      { key: "baseUrl_3", value: "https://api.example.com/admin/v3", type: "default", enabled: true },
    ]);

    // With sourceUrl, relative servers resolve against sourceUrl.
    const withSource = importOpenApi(
      {
        openapi: "3.0.3",
        info: { title: "RelativeWithSource", version: "1.0.0" },
        servers: [{ url: "/v1" }],
        paths: {
          "/items": {
            servers: [{ url: "/v2" }],
            get: { operationId: "listItems" },
            post: {
              operationId: "createItem",
              servers: [{ url: "../internal/v3" }],
            },
          },
        },
      },
      { sourceUrl: "https://docs.example.com/specs/openapi/petstore.yaml" },
    );
    expect(withSource.variables).toEqual([
      { key: "baseUrl", value: "https://docs.example.com/v1", type: "default", enabled: true },
      { key: "baseUrl_2", value: "https://docs.example.com/v2", type: "default", enabled: true },
      {
        key: "baseUrl_3",
        value: "https://docs.example.com/specs/internal/v3",
        type: "default",
        enabled: true,
      },
    ]);

    // Root-relative and directory-relative root servers without sourceUrl must not
    // duplicate the relative prefix on inherited operations.
    for (const rootServerUrl of ["/v1", "v1"]) {
      const inherited = importOpenApi({
        openapi: "3.0.3",
        info: { title: "InheritedRelativeRoot", version: "1.0.0" },
        servers: [{ url: rootServerUrl }],
        paths: {
          "/items": {
            get: { operationId: "listItems" },
          },
        },
      });
      expect(inherited.variables).toEqual([
        { key: "baseUrl", value: "http://localhost/v1", type: "default", enabled: true },
      ]);
      const [itemReq] = inherited.root.children as RequestNode[];
      expect(itemReq.url).toBe("{{baseUrl}}/items");
      const resolver = new Resolver({
        ...emptyScopes(),
        collection: variablesToRecord(inherited.variables),
      });
      expect(resolver.resolve(itemReq.url)).toBe("http://localhost/v1/items");
    }
  });

  it("populates templated server variables from defaults/enums and preserves unresolved variables without collision", () => {
    const { root, variables } = importOpenApi({
      openapi: "3.0.3",
      info: { title: "TemplatedServers", version: "1.0.0" },
      servers: [
        {
          url: "https://{region}.{env}.example.com/{env}",
          variables: {
            region: { enum: ["us-east", "eu-west"] },
            env: { default: "prod" },
          },
        },
      ],
      paths: {
        "/tenants/{baseUrl_2}/resources": {
          servers: [
            {
              url: "https://{tenant}.api.example.com:{port}/{basePath}",
              variables: {
                port: { default: "8443" },
                basePath: { enum: ["v2", "v1"] },
                // `tenant` is intentionally omitted from `variables` to test unresolved placeholder preservation.
              },
            },
          ],
          get: {
            operationId: "getTenantResources",
          },
          post: {
            operationId: "createTenantResource",
            servers: [
              {
                url: "https://{tenant}.ingest.example.com/{stage}",
                variables: {
                  stage: { default: "live" },
                },
              },
            ],
          },
        },
      },
    });

    // `baseUrl_2` is a path parameter on `/tenants/{baseUrl_2}/resources`, so the server
    // override variable skips `baseUrl_2` and uses `baseUrl_3` / `baseUrl_4` instead.
    expect(variables).toEqual([
      {
        key: "baseUrl",
        value: "https://us-east.prod.example.com/prod",
        type: "default",
        enabled: true,
      },
      { key: "tenant", value: "", type: "default", enabled: true },
      {
        key: "baseUrl_3",
        value: "https://{{tenant}}.api.example.com:8443/v2",
        type: "default",
        enabled: true,
      },
      {
        key: "baseUrl_4",
        value: "https://{{tenant}}.ingest.example.com/live",
        type: "default",
        enabled: true,
      },
    ]);

    const [getReq, postReq] = root.children as RequestNode[];
    expect(getReq.url).toBe("{{baseUrl_3}}/tenants/{{baseUrl_2}}/resources");
    expect(postReq.url).toBe("{{baseUrl_4}}/tenants/{{baseUrl_2}}/resources");

    const resolver = new Resolver({
      ...emptyScopes(),
      collection: {
        ...variablesToRecord(variables),
        tenant: "acme",
        baseUrl_2: "t-42",
      },
    });
    expect(resolver.resolve(getReq.url)).toBe(
      "https://acme.api.example.com:8443/v2/tenants/t-42/resources",
    );
    expect(resolver.resolve(postReq.url)).toBe(
      "https://acme.ingest.example.com/live/tenants/t-42/resources",
    );
  });

  it("honors Swagger 2.0 operation-level schemes override", () => {
    const { root, variables } = importOpenApi({
      swagger: "2.0",
      info: { title: "SwaggerSchemes", version: "1.0" },
      host: "legacy.example.com",
      basePath: "/v1",
      schemes: ["https"],
      paths: {
        "/secure": {
          get: { operationId: "getSecure" },
        },
        "/health": {
          get: {
            operationId: "getHealthPlain",
            schemes: ["http"],
          },
        },
      },
    });

    expect(variables).toEqual([
      { key: "baseUrl", value: "https://legacy.example.com/v1", type: "default", enabled: true },
      { key: "baseUrl_2", value: "http://legacy.example.com/v1", type: "default", enabled: true },
    ]);
    const [secureReq, healthReq] = root.children as RequestNode[];
    expect(secureReq.url).toBe("{{baseUrl}}/secure");
    expect(healthReq.url).toBe("{{baseUrl_2}}/health");
  });
});

describe("code generation", () => {
  const req = {
    method: "POST",
    url: "https://api.test/items?x=1",
    headers: [
      ["Content-Type", "application/json"],
      ["Authorization", "Bearer it's"],
      ["User-Agent", "Postbox/0.1"],
    ] as [string, string][],
    body: { mode: "raw" as const, raw: '{"a":1}', language: "json" as const },
  };
  it("generates cURL with proper quoting", () => {
    const s = generateSnippet("curl", req);
    expect(s).toContain("curl --location --request 'POST' 'https://api.test/items?x=1'");
    expect(s).toContain(`--header 'Authorization: Bearer it'\\''s'`);
    expect(s).toContain(`--data-raw '{"a":1}'`);
    expect(s).not.toContain("User-Agent");
    // The generated command must round-trip through the cURL importer.
    const back = parseCurl(s.replace(/\\\n/g, " "));
    expect(back.method).toBe("POST");
    expect(back.headers.find((h) => h.key === "Authorization")?.value).toBe("Bearer it's");
  });
  it.each([
    "POST; printf injected",
    "$(printf injected)",
    "`printf injected`",
    "POST' ; printf injected; #",
    "POST\nNEXT",
    'POST" \\ $HOME & | < >',
  ])("passes the cURL method as one literal shell argument: %j", (method) => {
    const snippet = generateSnippet("curl", { ...req, method });
    // Stub curl to capture arguments without making a network request.
    const output = execFileSync("sh", ["-c", `curl() { printf '%s\\0' "$@"; }; ${snippet}`], {
      encoding: "utf8",
    });
    expect(output.split("\0").slice(0, -1)).toEqual([
      "--location",
      "--request",
      method,
      req.url,
      "--header",
      "Content-Type: application/json",
      "--header",
      "Authorization: Bearer it's",
      "--data-raw",
      req.body.raw,
    ]);
  });

  it("keeps normal GET snippets free of an explicit method", () => {
    expect(generateSnippet("curl", { ...req, method: "GET", body: { mode: "none" } })).toBe(
      "curl --location 'https://api.test/items?x=1' \\\n  --header 'Content-Type: application/json' \\\n  --header 'Authorization: Bearer it'\\''s'",
    );
  });

  const powerShellBodies = [
    '{"a":1}',
    "before\n'@\nWrite-Output 'injected'\n@'\nafter",
    "before\r\n'@; Write-Output 'injected'\r\nafter\r\n",
    "' \" ` $($env:HOME) \\ \0",
    "Unicode: café 日本語 🚀 ‘single’ “double”",
    "\nleading and trailing\n\n",
  ];
  it.each(powerShellBodies)("encodes PowerShell bodies as exact UTF-8 bytes: %j", (raw) => {
    const snippet = generateSnippet("powershell", {
      ...req,
      body: { mode: "raw", language: "text", raw },
    });
    const match = snippet.match(/^\$body = \[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)$/m);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], "base64")).toEqual(Buffer.from(raw, "utf8"));
    expect(snippet).not.toContain("@'");
    expect(snippet).toContain("-Body $body");
  });

  const hasPowerShell =
    spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
  it.skipIf(!hasPowerShell)("executes PowerShell snippets without evaluating body text", () => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      // Capture the actual body argument and avoid sending requests.
      `function Invoke-RestMethod {
        param($Uri, $Method, $Headers, [byte[]]$Body, $ContentType)
        [System.Convert]::ToBase64String($Body)
      }`,
      ...powerShellBodies.map((raw) =>
        generateSnippet("powershell", { ...req, body: { mode: "raw", language: "text", raw } }),
      ),
    ].join("\n");
    const output = execFileSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8" },
    );
    expect(
      output
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)),
    ).toEqual(powerShellBodies.map((raw) => Buffer.from(raw, "utf8").toString("base64")));
  });

  it("generates fetch, Python and PowerShell", () => {
    expect(generateSnippet("fetch", req)).toContain('await fetch("https://api.test/items?x=1"');
    expect(generateSnippet("python", req)).toContain(
      'requests.request("POST", url, headers=headers, data=payload)',
    );
    const ps = generateSnippet("powershell", req);
    expect(ps).toContain("Invoke-RestMethod -Uri 'https://api.test/items?x=1' -Method 'POST'");
    expect(ps).toContain("-ContentType 'application/json'");
    expect(
      generateSnippet("python", {
        ...req,
        body: {
          mode: "formdata",
          formdata: [{ key: "f", value: "", enabled: true, type: "file", fileName: "a.csv" }],
        },
      }),
    ).toContain('("f", ("a.csv", open("a.csv", "rb")))');
  });
});
