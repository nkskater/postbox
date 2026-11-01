import { describe, expect, it } from "vitest";
import type { FolderNode, RequestNode } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { generateDocumentation } from "@/core/documentation/generate";
import { renderDocumentation } from "@/core/documentation/render";
import { publicationInputSchema } from "@/core/documentation/model";
const request = (partial: Partial<RequestNode> = {}): RequestNode => ({
  kind: "request",
  id: "request",
  name: "Get pet",
  method: "GET",
  url: "https://example.test/pets/1",
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "inherit" },
  settings: DEFAULT_SETTINGS,
  preRequestScript: "",
  testScript: "",
  ...partial,
});
const folder = (children: FolderNode["children"], partial: Partial<FolderNode> = {}): FolderNode => ({
  kind: "folder",
  id: "collection",
  name: "Pets",
  description: "Pet API",
  headers: [],
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  children,
  ...partial,
});
describe("documentation generator and renderer", () => {
  it("renders a deterministic sanitized snapshot with inherited auth and headers", () => {
    const snapshot = generateDocumentation(
      folder([request()], {
        auth: { type: "bearer", bearer: { token: "very-secret-auth" } },
        headers: [{ key: "X-Region", value: "west", enabled: true }],
      }),
      [
        { key: "baseUrl", value: "https://private.test", type: "default", enabled: true },
        { key: "apiKey", value: "very-secret-variable", type: "secret", enabled: true },
      ],
    );
    expect({
      name: snapshot.root.name,
      variables: snapshot.variables,
      auth: snapshot.authTypes,
      request: snapshot.root.children[0],
    }).toMatchObject({
      name: "Pets",
      variables: [
        { key: "baseUrl", type: "default", enabled: true },
        { key: "apiKey", type: "secret", enabled: true },
      ],
      auth: { request: "bearer" },
      request: {
        headers: [{ key: "X-Region", value: "west", enabled: true }],
        auth: { type: "none" },
        preRequestScript: "",
        testScript: "",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("very-secret");
    expect(JSON.stringify(snapshot)).not.toContain("private.test");
    expect(snapshot.variables).toMatchInlineSnapshot(`
     [
       {
         "enabled": true,
         "key": "baseUrl",
         "type": "default",
       },
       {
         "enabled": true,
         "key": "apiKey",
         "type": "secret",
       },
     ]
   `);
  });
  it("omits credentials, scripts, uploads, example original requests and known secret variants", () => {
    const secret = "secret-value-123";
    const raw = folder([
      request({
        url: `https://user:${secret}@example.test/pets?token=${secret}`,
        headers: [{ key: "Authorization", value: `Bearer ${secret}`, enabled: true }],
        body: {
          mode: "formdata",
          formdata: [
            {
              key: "file",
              value: "",
              enabled: true,
              type: "file",
              data: Buffer.from("private-file").toString("base64"),
              fileName: "secret-file",
            },
            { key: "password", value: secret, type: "text", enabled: true },
          ],
        },
        preRequestScript: "script-private-123",
        testScript: "more-private-code",
        description: encodeURIComponent(secret),
        examples: [
          {
            id: "example",
            name: "OK",
            status: 200,
            statusText: "OK",
            headers: [{ key: "Set-Cookie", value: secret, enabled: true }],
            body: JSON.stringify({ password: secret, other: secret }),
            createdAt: 1,
            originalRequest: {
              method: "GET",
              url: "https://private-original.test",
              params: [],
              headers: [],
              auth: { type: "bearer", bearer: { token: secret } },
              body: { mode: "none" },
            },
          },
        ],
      }),
    ]);
    const snapshot = generateDocumentation(raw, [], [secret]);
    const serialized = JSON.stringify(snapshot);
    for (const value of [
      secret,
      "script-private-123",
      "more-private-code",
      "private-original.test",
      "secret-file",
      Buffer.from("private-file").toString("base64"),
    ])
      expect(serialized).not.toContain(value);
    expect(serialized).toContain("[REDACTED]");
    expect(raw.children[0].preRequestScript).toBe("script-private-123");
  });
  it("escapes hostile content in every HTML context and includes only trusted nonce scripts", () => {
    const attack = "</script><img src=x onerror=alert(1)><script>alert(2)</script>";
    const snapshot = generateDocumentation(
      folder(
        [
          request({
            name: attack,
            description: attack,
            url: "https://example.test/?x=" + attack,
            examples: [
              {
                id: "e",
                name: attack,
                status: 200,
                statusText: "OK",
                body: attack,
                headers: [],
                createdAt: 1,
              },
            ],
          }),
        ],
        { name: attack },
      ),
      [],
    );
    const html = renderDocumentation(snapshot, {
      title: attack,
      visibility: "public",
      revision: 1,
      id: "abc123",
      nonce: "trusted-nonce",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img");
    expect(html.match(/<script /g)).toHaveLength(1);
    expect(html).toContain('nonce="trusted-nonce"');
    expect(html).toContain("Search endpoints");
    expect(html).toContain("Import into Postbox");
    expect(html).toContain("JavaScript fetch");
    expect(html).not.toContain("Snippet unavailable");
  });
  it("redacts encoded sensitive query names before copying their values into other fields", () => {
    const snapshot = generateDocumentation(
      folder([
        request({
          url: "https://example.test/?%74oken=encoded-sensitive-value",
          description: "Do not publish encoded-sensitive-value",
        }),
      ]),
      [],
    );
    expect(JSON.stringify(snapshot)).not.toContain("encoded-sensitive-value");
  });
  it("marks omitted binary/truncated examples and limits per-request examples", () => {
    const examples = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      name: "E",
      status: 200,
      statusText: "OK",
      headers: [],
      createdAt: 1,
      body: "abc",
      bodyEncoding: "base64" as const,
    }));
    const snapshot = generateDocumentation(folder([request({ examples })]), []);
    const req = snapshot.root.children[0] as RequestNode;
    expect(req.examples).toHaveLength(5);
    expect(req.examples?.every((e) => e.bodyOmitted && e.body === "")).toBe(true);
    expect(snapshot.omissions.join(" ")).toContain("first five");
  });
  it("enforces endpoint, depth and final snapshot size limits", () => {
    expect(() =>
      generateDocumentation(folder(Array.from({ length: 501 }, (_, i) => request({ id: String(i) }))), []),
    ).toThrow(/500 requests/);
    let root = folder([request()]);
    for (let i = 0; i < 34; i++) root = folder([root]);
    expect(() => generateDocumentation(root, [])).toThrow(/depth/);
    expect(() =>
      generateDocumentation(
        folder(
          Array.from({ length: 90 }, (_, i) =>
            request({ id: String(i), body: { mode: "raw", language: "text", raw: "x".repeat(32768) } }),
          ),
        ),
        [],
      ),
    ).toThrow(/2 MiB/);
  });
  it("only accepts a bare HTTP(S) custom origin", () => {
    for (const origin of [
      "javascript:alert(1)",
      "https://user:password@docs.test",
      "https://docs.test/path",
      "https://docs.test?q=x",
    ]) {
      expect(
        publicationInputSchema.safeParse({ visibility: "public", expectedRevision: 0, customOrigin: origin })
          .success,
      ).toBe(false);
    }
    expect(
      publicationInputSchema.safeParse({
        visibility: "private",
        expectedRevision: 0,
        customOrigin: "https://docs.test:8443",
      }).success,
    ).toBe(true);
  });
});
