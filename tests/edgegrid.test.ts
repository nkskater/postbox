import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_BODY_SIZE,
  buildEdgeGridAuthHeader,
  canonicalizeHeaders,
  createDataToSign,
  createSignature,
  createSigningKey,
  formatEdgeGridTimestamp,
  makeContentHash,
  parseEdgeGridUrl,
} from "@/core/http/edgegrid";
import { applyAuth, resolveAuth, resolveEffectiveAuth } from "@/core/http/auth";
import { exportPostmanCollection, importAuth, importPostmanCollection } from "@/core/convert/postman";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import type { AuthConfig, EdgeGridConfig, PreparedRequest, RequestNode } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

describe("Akamai EdgeGrid authentication (EG1-HMAC-SHA256)", () => {
  const sampleConfig: EdgeGridConfig = {
    clientToken: "akaa-client-token-xxx",
    clientSecret: "client-secret-key-12345",
    accessToken: "akaa-access-token-yyy",
    baseURL: "https://akab-example.luna.akamaiapis.net",
    headersToSign: "Content-Type, X-Custom-Header",
    maxBodySize: 131072,
    timestamp: "20261030T12:34:56+0000",
    nonce: "test-nonce-123e4567-e89b-12d3-a456-426614174000",
  };

  describe("formatEdgeGridTimestamp", () => {
    it("formats a Date in yyyyMMddTHH:mm:ss+0000 format", () => {
      const date = new Date(Date.UTC(2026, 9, 30, 15, 45, 9)); // month is 0-indexed: 9 = Oct
      expect(formatEdgeGridTimestamp(date)).toBe("20261030T15:45:09+0000");
    });
  });

  describe("makeContentHash", () => {
    it("returns empty string for GET, HEAD, OPTIONS requests", () => {
      expect(makeContentHash("body content", "GET")).toBe("");
      expect(makeContentHash("body content", "HEAD")).toBe("");
      expect(makeContentHash("body content", "OPTIONS")).toBe("");
    });

    it("returns empty string for empty body or undefined body", () => {
      expect(makeContentHash("", "POST")).toBe("");
      expect(makeContentHash(undefined, "POST")).toBe("");
      expect(makeContentHash(Buffer.alloc(0), "POST")).toBe("");
    });

    it("hashes POST bodies only", () => {
      const body = JSON.stringify({ message: "hello edgegrid" });
      expect(makeContentHash(body, "POST")).toBe("x4GBJsxn/Ex9iwgv+2HM6xbdy7kQL2fTFYcXracgHsI=");
      expect(makeContentHash(body, "PUT")).toBe("");
      expect(makeContentHash(body, "PATCH")).toBe("");
    });

    it("truncates body to maxBodySize before hashing", () => {
      const full = "A".repeat(200);
      const truncatedHash = makeContentHash(full, "POST", 50);
      const slicedHash = makeContentHash("A".repeat(50), "POST", 50);
      expect(truncatedHash).toBe(slicedHash);
    });
  });

  describe("canonicalizeHeaders", () => {
    it("returns empty string when headersToSign is not provided or empty", () => {
      expect(canonicalizeHeaders([["Content-Type", "application/json"]], undefined)).toBe("");
      expect(canonicalizeHeaders([["Content-Type", "application/json"]], "")).toBe("");
    });

    it("lowercases header names, collapses whitespace, keeps configured order, and joins with tabs", () => {
      const headers: [string, string][] = [
        ["X-Custom-Header", "   value1    extra   "],
        ["Content-Type", "application/json"],
        ["User-Agent", "Postbox/1.0"],
      ];

      const canonical = canonicalizeHeaders(headers, "X-Custom-Header, Content-Type");
      expect(canonical).toBe("x-custom-header:value1 extra\tcontent-type:application/json");
    });

    it("handles array of headersToSign", () => {
      const headers: [string, string][] = [
        ["Content-Type", "application/json"],
        ["X-Header", "test"],
      ];
      const canonical = canonicalizeHeaders(headers, ["X-Header", "Content-Type"]);
      expect(canonical).toBe("x-header:test\tcontent-type:application/json");
    });
  });

  describe("signing key and signature creation", () => {
    it("generates deterministic signing key and signature", () => {
      const key = createSigningKey(sampleConfig.timestamp!, sampleConfig.clientSecret);
      expect(key).toBeTruthy();
      expect(typeof key).toBe("string");

      const dataToSign = "GET\thttps\takab-example.luna.akamaiapis.net\t/api/v1/test\t\t\tprefix";
      const sig1 = createSignature(dataToSign, key);
      const sig2 = createSignature(dataToSign, key);
      expect(sig1).toBe(sig2);
      expect(sig1).toBeTruthy();
    });
  });

  describe("createDataToSign", () => {
    it("creates 7 tab-delimited parts", () => {
      const url = parseEdgeGridUrl("/api/v1/resource?foo=bar", sampleConfig.baseURL);
      const prefix = "EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=ts;nonce=nc;";
      const data = createDataToSign({
        method: "POST",
        url,
        authHeaderPrefix: prefix,
        headers: [["Content-Type", "application/json"]],
        headersToSign: "Content-Type",
        body: '{"test":true}',
        maxBodySize: DEFAULT_MAX_BODY_SIZE,
      });

      const parts = data.split("\t");
      expect(parts).toHaveLength(7);
      expect(parts[0]).toBe("POST");
      expect(parts[1]).toBe("https");
      expect(parts[2]).toBe("akab-example.luna.akamaiapis.net");
      expect(parts[3]).toBe("/api/v1/resource?foo=bar");
      expect(parts[4]).toBe("content-type:application/json");
      expect(parts[5]).toBeTruthy(); // body hash
      expect(parts[6]).toBe(prefix);
    });
  });

  describe("buildEdgeGridAuthHeader", () => {
    it("builds a full Authorization header with EG1-HMAC-SHA256 format", () => {
      const header = buildEdgeGridAuthHeader(sampleConfig, {
        method: "GET",
        url: "https://akab-example.luna.akamaiapis.net/test/endpoint",
      });

      expect(header).toMatch(
        /^EG1-HMAC-SHA256 client_token=akaa-client-token-xxx;access_token=akaa-access-token-yyy;timestamp=20261030T12:34:56\+0000;nonce=test-nonce-123e4567-e89b-12d3-a456-426614174000;signature=.+$/,
      );
    });

    it("generates timestamp and nonce when not provided", () => {
      const cfg: EdgeGridConfig = {
        clientToken: "c-token",
        clientSecret: "c-secret",
        accessToken: "a-token",
        baseURL: "https://api.example.com",
      };
      const header = buildEdgeGridAuthHeader(cfg, { method: "GET", url: "/path" });
      expect(header).toContain("client_token=c-token;access_token=a-token;");
      expect(header).toContain("timestamp=");
      expect(header).toContain("nonce=");
      expect(header).toContain("signature=");
    });
  });

  describe("resolveAuth", () => {
    it("substitutes {{variables}} in all EdgeGrid string fields", () => {
      const r = new Resolver({
        globals: {
          clientToken: "resolved-client-token",
          clientSecret: "resolved-client-secret",
          accessToken: "resolved-access-token",
          baseUrl: "https://resolved.akamaiapis.net",
          headers: "X-Resolved",
        },
        collection: {},
        environment: {},
        data: {},
        local: {},
      });

      const resolved = resolveAuth(
        {
          type: "edgegrid",
          edgegrid: {
            clientToken: "{{clientToken}}",
            clientSecret: "{{clientSecret}}",
            accessToken: "{{accessToken}}",
            baseURL: "{{baseUrl}}",
            headersToSign: "{{headers}}",
          },
        },
        r,
      );

      if (resolved.type !== "edgegrid") throw new Error("Expected edgegrid");
      expect(resolved.edgegrid.clientToken).toBe("resolved-client-token");
      expect(resolved.edgegrid.clientSecret).toBe("resolved-client-secret");
      expect(resolved.edgegrid.accessToken).toBe("resolved-access-token");
      expect(resolved.edgegrid.baseURL).toBe("https://resolved.akamaiapis.net");
      expect(resolved.edgegrid.headersToSign).toBe("X-Resolved");
    });
  });

  describe("resolveEffectiveAuth", () => {
    it("inherits EdgeGrid auth from collection or folder", () => {
      const parentAuth: AuthConfig = {
        type: "edgegrid",
        edgegrid: sampleConfig,
      };
      const childAuth: AuthConfig = { type: "inherit" };
      const effective = resolveEffectiveAuth([parentAuth, childAuth]);
      expect(effective).toEqual(parentAuth);
    });
  });

  describe("applyAuth", () => {
    it("applies EdgeGrid Authorization header to PreparedRequest", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "https://akab-example.luna.akamaiapis.net/items",
        headers: [],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(req, { type: "edgegrid", edgegrid: sampleConfig });
      const authHeader = req.headers.find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader).toBeDefined();
      expect(authHeader![1]).toContain("EG1-HMAC-SHA256 client_token=akaa-client-token-xxx");
    });

    it("does not overwrite explicit user-defined Authorization header", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "https://akab-example.luna.akamaiapis.net/items",
        headers: [["Authorization", "Custom-Explicit-Token"]],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(req, { type: "edgegrid", edgegrid: sampleConfig });
      const authHeader = req.headers.find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader![1]).toBe("Custom-Explicit-Token");
    });

    it("supports offline stub mode even with missing credentials", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "https://akab-example.luna.akamaiapis.net/items",
        headers: [],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(
        req,
        {
          type: "edgegrid",
          edgegrid: { clientToken: "", clientSecret: "", accessToken: "" },
        },
        undefined,
        true, // offline
      );

      const authHeader = req.headers.find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader).toBeDefined();
      expect(authHeader![1]).toContain("EG1-HMAC-SHA256 client_token=<client-token>");
    });

    it("throws error when live credentials are missing", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "https://akab-example.luna.akamaiapis.net/items",
        headers: [],
        settings: DEFAULT_SETTINGS,
      };

      await expect(
        applyAuth(req, {
          type: "edgegrid",
          edgegrid: { clientToken: "", clientSecret: "", accessToken: "" },
        }),
      ).rejects.toThrow("Akamai EdgeGrid: clientToken, clientSecret, and accessToken are required");
    });
  });

  describe("Postman import and export", () => {
    it("imports and exports EdgeGrid auth correctly", () => {
      const imported = importAuth({
        type: "edgegrid",
        edgegrid: [
          { key: "clientToken", value: "tok-1", type: "string" },
          { key: "clientSecret", value: "sec-1", type: "string" },
          { key: "accessToken", value: "acc-1", type: "string" },
          { key: "baseURL", value: "https://api.test", type: "string" },
          { key: "headersToSign", value: "Content-Type", type: "string" },
          { key: "maxBodySize", value: "65536", type: "string" },
        ],
      });

      expect(imported).toEqual({
        type: "edgegrid",
        edgegrid: {
          clientToken: "tok-1",
          clientSecret: "sec-1",
          accessToken: "acc-1",
          baseURL: "https://api.test",
          headersToSign: "Content-Type",
          maxBodySize: 65536,
          nonce: undefined,
          timestamp: undefined,
        },
      });

      const col = {
        info: {
          name: "Test Col",
          schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [
          {
            name: "EdgeGrid Req",
            request: {
              method: "GET",
              url: "https://api.test/data",
              auth: {
                type: "edgegrid",
                edgegrid: [
                  { key: "clientToken", value: "tok-1", type: "string" },
                  { key: "clientSecret", value: "sec-1", type: "string" },
                  { key: "accessToken", value: "acc-1", type: "string" },
                ],
              },
            },
          },
        ],
      };

      const parsedCol = importPostmanCollection(col);
      const reqNode = parsedCol.root.children[0] as RequestNode;
      expect(reqNode.auth.type).toBe("edgegrid");

      expect(JSON.stringify(exportPostmanCollection(parsedCol.root, []))).not.toContain("sec-1");
      const exported = exportPostmanCollection(parsedCol.root, [], { includeCredentials: true });
      const exportedItem = exported.item[0] as { request: { auth: { type: string; edgegrid: unknown[] } } };
      expect(exportedItem.request.auth.type).toBe("edgegrid");
      expect(exportedItem.request.auth.edgegrid).toEqual(
        expect.arrayContaining([
          { key: "clientToken", value: "tok-1", type: "string" },
          { key: "clientSecret", value: "sec-1", type: "string" },
          { key: "accessToken", value: "acc-1", type: "string" },
        ]),
      );
    });
  });

  describe("Security and secret redaction", () => {
    it("redacts clientSecret when redacting stored values", () => {
      const config: EdgeGridConfig = {
        clientToken: "c-token",
        clientSecret: "super-secret-key-9999",
        accessToken: "a-token",
      };

      const payload = {
        name: "My Request",
        auth: { type: "edgegrid", edgegrid: config },
      };

      const redacted = redactStoredValue(payload, [config.clientSecret]);
      expect(redacted.auth.edgegrid.clientSecret).toBe("********");
      expect(redacted.auth.edgegrid.clientToken).toBe("c-token");
    });
  });
});

describe("EdgeGrid official SDK fixtures", () => {
  const fixtures = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/edgegrid/test_data.json"), "utf-8"),
  ) as {
    base_url: string;
    access_token: string;
    client_token: string;
    client_secret: string;
    max_body: number;
    headers_to_sign: string[];
    nonce: string;
    timestamp: string;
    tests: {
      testName: string;
      request: { method: string; path: string; data?: string; headers?: Record<string, string>[] };
      expectedAuthorization: string;
    }[];
  };

  // The SDK's own test.js asserts a different value for this case than its JSON file does.
  const sdkAssertions: Record<string, string> = {
    "POST inside limit": "hXm4iCxtpN22m4cbZb4lVLW5rhX8Ca82vCFqXzSTPe4=",
  };

  it.each(fixtures.tests.map((t) => [t.testName, t] as const))("%s", (name, t) => {
    const header = buildEdgeGridAuthHeader(
      {
        clientToken: fixtures.client_token,
        clientSecret: fixtures.client_secret,
        accessToken: fixtures.access_token,
        headersToSign: fixtures.headers_to_sign.join(","),
        maxBodySize: fixtures.max_body,
        nonce: fixtures.nonce,
        timestamp: fixtures.timestamp,
      },
      {
        method: t.request.method,
        url: new URL(t.request.path, fixtures.base_url).toString(),
        headers: (t.request.headers ?? []).flatMap((h) => Object.entries(h)),
        body: t.request.data,
      },
    );
    const expected = sdkAssertions[name]
      ? t.expectedAuthorization.replace(/signature=.*$/, `signature=${sdkAssertions[name]}`)
      : t.expectedAuthorization;
    expect(header).toBe(expected);
  });

  it("keeps the configured headersToSign order", () => {
    expect(
      canonicalizeHeaders(
        [
          ["X-A", "a"],
          ["X-Z", "z"],
        ],
        "X-Z,X-A",
      ),
    ).toBe("x-z:z\tx-a:a");
  });
});
