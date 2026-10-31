import { describe, expect, it } from "vitest";
import { encodeBody } from "@/core/http/body";
import { exportPostmanCollection, importPostmanCollection } from "@/core/convert/postman";
import { bodySchema } from "@/core/schemas";
import {
  MAX_UPLOAD_BASE64_CHARS,
  redactSensitiveFields,
  restoreMissingCredentials,
  restoreMissingUploadBytes,
  sanitizeRequestDraftForBrowser,
} from "@/core/retention";
import type { FolderNode, RequestNode } from "@/core/types";
import { newDraft } from "@/stores/app";

describe("credential and upload retention", () => {
  it("removes auth credentials and uploaded bytes from a browser-restored draft", () => {
    const draft = newDraft({
      url: "https://example.test/?token=private-token",
      auth: {
        type: "oauth2",
        oauth2: {
          grantType: "client_credentials",
          accessTokenUrl: "https://example.test/token",
          clientId: "public-client-id",
          clientSecret: "client-secret-value",
          scope: "read",
          clientAuthentication: "header",
          accessToken: "cached-access-token",
          headerPrefix: "Bearer",
        },
      },
      body: {
        mode: "binary",
        binary: {
          fileName: "payload.bin",
          contentType: "application/octet-stream",
          data: "c2VjcmV0LWZpbGU=",
        },
      },
      examples: [
        {
          id: "example",
          name: "echo",
          status: 200,
          statusText: "OK",
          headers: [{ key: "X-Echo", value: "client-secret-value", enabled: true }],
          body: "client-secret-value",
          createdAt: 1,
        },
      ],
    });

    const safe = sanitizeRequestDraftForBrowser(draft);
    expect(JSON.stringify(safe)).not.toContain("client-secret-value");
    expect(JSON.stringify(safe)).not.toContain("cached-access-token");
    expect(JSON.stringify(safe)).not.toContain("private-token");
    expect(safe.url).toContain("token=[REDACTED]");
    expect(safe.auth).toMatchObject({
      type: "oauth2",
      oauth2: { clientId: "public-client-id", clientSecret: "", accessToken: "" },
    });
    expect(safe.body).toMatchObject({
      mode: "binary",
      binary: { fileName: "payload.bin", data: "", missing: true },
    });
    expect(safe.examples?.[0].body).toBe("********");
  });

  it("rejects request upload payloads above the shared 5 MiB cap", () => {
    const oversized = "A".repeat(MAX_UPLOAD_BASE64_CHARS + 4);
    const exactLimit = `${"A".repeat(MAX_UPLOAD_BASE64_CHARS - 1)}=`;
    expect(
      bodySchema.safeParse({ mode: "binary", binary: { fileName: "limit.bin", data: exactLimit } }).success,
    ).toBe(true);
    expect(
      bodySchema.safeParse({ mode: "binary", binary: { fileName: "large.bin", data: oversized } }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        mode: "formdata",
        formdata: [{ key: "file", value: "", enabled: true, type: "file", data: oversized }],
      }).success,
    ).toBe(false);
  });

  it("redacts credential-shaped values from headers, params, and JSON artifacts", () => {
    expect(
      redactSensitiveFields({
        headers: [{ key: "Authorization", value: "Bearer raw-secret", enabled: true }],
        params: [{ key: "api_key", value: "query-secret", enabled: true }],
        response: '{"access_token":"echoed-secret","safe":"visible"}',
      }),
    ).toEqual({
      headers: [{ key: "Authorization", value: "[REDACTED]", enabled: true }],
      params: [{ key: "api_key", value: "[REDACTED]", enabled: true }],
      response: '{"access_token":"[REDACTED]","safe":"visible"}',
    });
  });

  it("requires stripped draft uploads to be reselected before sending", () => {
    expect(() =>
      encodeBody({ mode: "binary", binary: { fileName: "payload.bin", data: "", missing: true } }, "POST"),
    ).toThrow("Re-select the binary file");
    expect(() =>
      encodeBody(
        {
          mode: "formdata",
          formdata: [{ key: "file", value: "", enabled: true, type: "file", missing: true }],
        },
        "POST",
      ),
    ).toThrow('Re-select the file for form-data field "file"');
  });

  it("restores omitted sensitive data from the saved server request after browser hydration", () => {
    const savedAuth = { type: "bearer", bearer: { token: "server-token" } } as const;
    const localAuth = { type: "bearer", bearer: { token: "" } } as const;
    expect(restoreMissingCredentials(localAuth, savedAuth)).toEqual(savedAuth);
    const localBody = {
      mode: "binary",
      binary: { fileName: "payload.bin", data: "", missing: true },
    } as const;
    const savedBody = { mode: "binary", binary: { fileName: "payload.bin", data: "cGF5bG9hZA==" } } as const;
    expect(restoreMissingUploadBytes(localBody, savedBody)).toEqual({
      mode: "binary",
      binary: { fileName: "payload.bin", data: "cGF5bG9hZA==", missing: false },
    });
  });

  it("omits auth credentials by default, redacts response examples, and supports explicit export opt-in", () => {
    const request: RequestNode = {
      kind: "request",
      id: "request",
      name: "Echo",
      method: "GET",
      url: "https://example.test",
      params: [{ key: "api_key", value: "query-key-secret", enabled: true }],
      headers: [{ key: "Authorization", value: "header-auth-secret", enabled: true }],
      body: { mode: "urlencoded", urlencoded: [{ key: "password", value: "body-password", enabled: true }] },
      auth: { type: "basic", basic: { username: "user", password: "request-password" } },
      preRequestScript: "",
      testScript: "",
      settings: {
        followRedirects: true,
        maxRedirects: 10,
        timeoutMs: 1000,
        verifySsl: true,
        useCookieJar: false,
      },
      examples: [
        {
          id: "example",
          name: "response",
          status: 200,
          statusText: "OK",
          createdAt: 1,
          headers: [{ key: "X-Echo", value: "request-password", enabled: true }],
          body: "request-password and env-secret",
        },
      ],
    };
    const root: FolderNode = {
      kind: "folder",
      id: "root",
      name: "Collection",
      auth: { type: "bearer", bearer: { token: "collection-token" } },
      headers: [],
      preRequestScript: "",
      testScript: "",
      children: [request],
    };

    const safe = exportPostmanCollection(root, [
      { key: "secret", value: "env-secret", type: "secret", enabled: true },
    ]);
    const safeJson = JSON.stringify(safe);
    expect(safeJson).not.toContain("collection-token");
    expect(safeJson).not.toContain("request-password");
    expect(safeJson).not.toContain("env-secret");
    expect(safeJson).not.toContain("query-key-secret");
    expect(safeJson).not.toContain("header-auth-secret");
    expect(safeJson).not.toContain("body-password");
    expect(safeJson).toContain('"password","value":""');
    expect(safeJson).toContain("********");

    const optedIn = exportPostmanCollection(
      root,
      [{ key: "secret", value: "env-secret", type: "secret", enabled: true }],
      {
        includeCredentials: true,
        includeSecrets: true,
      },
    );
    const optedInJson = JSON.stringify(optedIn);
    expect(optedInJson).toContain("collection-token");
    expect(optedInJson).toContain("request-password");
    expect(optedInJson).toContain("env-secret");
    expect(optedInJson).toContain("query-key-secret");
    expect(optedInJson).toContain("header-auth-secret");
    expect(optedInJson).toContain("body-password");
  });

  it("redacts auth and secret-variable values from imported response examples", () => {
    const imported = importPostmanCollection({
      info: { name: "Imported" },
      auth: { type: "bearer", bearer: [{ key: "token", value: "import-token" }] },
      variable: [{ key: "private", value: "import-secret", type: "secret" }],
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: "https://example.test" },
          response: [{ name: "Echoed auth", code: 200, body: "import-token and import-secret" }],
        },
      ],
    });
    const example = (imported.root.children[0] as RequestNode).examples?.[0];
    expect(example?.body).toBe("******** and ********");
  });
});
