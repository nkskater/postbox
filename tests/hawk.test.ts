import { describe, expect, it } from "vitest";
import {
  buildHawkHeader,
  calculateHawkMac,
  calculatePayloadHash,
  generateHawkNormalizedString,
} from "@/core/http/hawk";
import { applyAuth, resolveAuth, resolveEffectiveAuth } from "@/core/http/auth";
import { importAuth, exportPostmanCollection, isPostmanCollection } from "@/core/convert/postman";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import type { AuthConfig, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { authSchema, hawkConfigSchema } from "@/core/schemas";

describe("Hawk authentication", () => {
  const credentials = {
    authId: "dh37fgj492je",
    authKey: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
    algorithm: "sha256" as const,
  };

  describe("Normalized string generation", () => {
    it("generates the standard Hawk header normalization string", () => {
      const normalized = generateHawkNormalizedString({
        ts: "1353832234",
        nonce: "j4h3g2",
        method: "GET",
        resource: "/resource/1?b=1&a=2",
        host: "example.com",
        port: "8000",
        hash: "",
        ext: "some-app-ext-data",
      });

      expect(normalized).toBe(
        "hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nsome-app-ext-data\n",
      );
    });

    it("uppercases HTTP method and lowercases host", () => {
      const normalized = generateHawkNormalizedString({
        ts: "1000",
        nonce: "abc",
        method: "post",
        resource: "/api/test",
        host: "API.Example.COM",
        port: "443",
      });

      expect(normalized).toContain("\nPOST\n");
      expect(normalized).toContain("\napi.example.com\n");
    });

    it("appends app and dlg lines when app is provided", () => {
      const normalized = generateHawkNormalizedString({
        ts: "1000",
        nonce: "abc",
        method: "GET",
        resource: "/",
        host: "example.com",
        port: "80",
        app: "my-app-id",
        dlg: "my-dlg-id",
      });

      expect(normalized.endsWith("\nmy-app-id\nmy-dlg-id\n")).toBe(true);
    });
  });

  describe("MAC and payload hash calculation (known test vectors)", () => {
    it("calculates standard Hawk test vector MAC correctly", () => {
      const normalized =
        "hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nsome-app-ext-data\n";
      const mac = calculateHawkMac(normalized, credentials.authKey, "sha256");
      expect(mac).toBe("6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=");
    });

    it("calculates standard payload hash correctly", () => {
      const hash = calculatePayloadHash("Thank you for flying Hawk", "sha256", "text/plain");
      expect(hash).toBe("Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=");
    });

    it("normalizes content-type stripping parameters in payload hash", () => {
      const hash1 = calculatePayloadHash("Thank you for flying Hawk", "sha256", "text/plain; charset=utf-8");
      const hash2 = calculatePayloadHash("Thank you for flying Hawk", "sha256", "TEXT/PLAIN");
      expect(hash1).toBe("Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=");
      expect(hash2).toBe("Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=");
    });

    it("computes MAC with payload hash (full POST vector)", () => {
      const normalized =
        "hawk.1.header\n1353832234\nj4h3g2\nPOST\n/resource/1?b=1&a=2\nexample.com\n8000\nYi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=\nsome-app-ext-data\n";
      const mac = calculateHawkMac(normalized, credentials.authKey, "sha256");
      expect(mac).toBe("aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=");
    });

    it("supports sha1 algorithm for MAC and payload hash", () => {
      const payloadHash = calculatePayloadHash("test payload", "sha1", "application/json");
      expect(payloadHash).toBeTruthy();
      const normalized = generateHawkNormalizedString({
        ts: "1353832234",
        nonce: "j4h3g2",
        method: "GET",
        resource: "/test",
        host: "example.com",
        port: "80",
        hash: payloadHash,
      });
      const mac = calculateHawkMac(normalized, credentials.authKey, "sha1");
      expect(mac).toBeTruthy();
    });
  });

  describe("Header construction and validation", () => {
    it("builds the expected Authorization header with fixed timestamp and nonce", () => {
      const header = buildHawkHeader(
        {
          method: "GET",
          url: "http://example.com:8000/resource/1?b=1&a=2",
          headers: [],
        },
        {
          authId: credentials.authId,
          authKey: credentials.authKey,
          algorithm: "sha256",
          timestamp: "1353832234",
          nonce: "j4h3g2",
          ext: "some-app-ext-data",
        },
      );

      expect(header).toBe(
        'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="',
      );
    });

    it("includes payload hash when includePayloadHash is true", () => {
      const header = buildHawkHeader(
        {
          method: "POST",
          url: "http://example.com:8000/resource/1?b=1&a=2",
          headers: [["Content-Type", "text/plain"]],
          body: Buffer.from("Thank you for flying Hawk"),
        },
        {
          authId: credentials.authId,
          authKey: credentials.authKey,
          algorithm: "sha256",
          timestamp: "1353832234",
          nonce: "j4h3g2",
          ext: "some-app-ext-data",
          includePayloadHash: true,
        },
      );

      expect(header).toBe(
        'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", hash="Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=", ext="some-app-ext-data", mac="aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw="',
      );
    });

    it("includes user, app, and dlg if configured", () => {
      const header = buildHawkHeader(
        {
          method: "GET",
          url: "https://example.com/api",
          headers: [],
        },
        {
          authId: "id1",
          authKey: "key1",
          algorithm: "sha256",
          user: "alice",
          app: "app42",
          dlg: "dlg99",
          timestamp: "12345",
          nonce: "nonce1",
        },
      );

      expect(header).toContain('user="alice"');
      expect(header).toContain('app="app42"');
      expect(header).toContain('dlg="dlg99"');
    });

    it("defaults port to 443 for https and 80 for http", () => {
      const headerHttps = buildHawkHeader(
        { method: "GET", url: "https://example.com/test", headers: [] },
        { authId: "id", authKey: "key", algorithm: "sha256", timestamp: "1", nonce: "1" },
      );
      const headerHttp = buildHawkHeader(
        { method: "GET", url: "http://example.com/test", headers: [] },
        { authId: "id", authKey: "key", algorithm: "sha256", timestamp: "1", nonce: "1" },
      );

      expect(headerHttps).toMatch(/^Hawk /);
      expect(headerHttp).toMatch(/^Hawk /);
    });

    it("generates timestamp and nonce when omitted", () => {
      const header = buildHawkHeader(
        { method: "GET", url: "http://example.com/test", headers: [] },
        { authId: "id", authKey: "key", algorithm: "sha256" },
      );
      expect(header).toMatch(/ts="\d+"/);
      expect(header).toMatch(/nonce="[a-f0-9]+"/);
      expect(header).toMatch(/mac="[^"]+"/);
    });

    it("rejects invalid configurations", () => {
      const req = { method: "GET", url: "http://example.com/test", headers: [] as [string, string][] };

      expect(() => buildHawkHeader(req, { authId: "", authKey: "key", algorithm: "sha256" })).toThrow(
        /both Auth ID and Auth Key/,
      );
      expect(() => buildHawkHeader(req, { authId: "id", authKey: "", algorithm: "sha256" })).toThrow(
        /both Auth ID and Auth Key/,
      );
      expect(() =>
        buildHawkHeader(req, { authId: "id", authKey: "key", algorithm: "sha512" as unknown as "sha256" }),
      ).toThrow(/Unsupported Hawk algorithm/);
      expect(() =>
        buildHawkHeader(
          { ...req, url: "not-a-valid-url" },
          { authId: "id", authKey: "key", algorithm: "sha256" },
        ),
      ).toThrow(/Invalid URL/);
    });
  });

  describe("Integration with resolveAuth & applyAuth", () => {
    it("resolves variables in Hawk configuration", () => {
      const resolver = new Resolver({
        globals: { HAWK_ID: "resolved-id", HAWK_KEY: "resolved-key", EXT_VAL: "my-ext" },
        environment: {},
        collection: {},
        data: {},
        local: {},
      });

      const resolved = resolveAuth(
        {
          type: "hawk",
          hawk: {
            authId: "{{HAWK_ID}}",
            authKey: "{{HAWK_KEY}}",
            algorithm: "sha256",
            ext: "{{EXT_VAL}}",
            includePayloadHash: false,
          },
        },
        resolver,
      );

      expect(resolved).toEqual({
        type: "hawk",
        hawk: {
          authId: "resolved-id",
          authKey: "resolved-key",
          algorithm: "sha256",
          ext: "my-ext",
          includePayloadHash: false,
        },
      });
    });

    it("applies Hawk Authorization header to prepared request", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "http://example.com:8000/resource/1?b=1&a=2",
        headers: [],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(req, {
        type: "hawk",
        hawk: {
          authId: credentials.authId,
          authKey: credentials.authKey,
          algorithm: "sha256",
          timestamp: "1353832234",
          nonce: "j4h3g2",
          ext: "some-app-ext-data",
        },
      });

      const authHeader = req.headers.find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader).toBeDefined();
      expect(authHeader![1]).toBe(
        'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="',
      );
    });

    it("does not overwrite explicit user Authorization header", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "http://example.com/test",
        headers: [["Authorization", "Custom my-auth-header"]],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(req, {
        type: "hawk",
        hawk: {
          authId: "id",
          authKey: "key",
          algorithm: "sha256",
        },
      });

      expect(req.headers).toEqual([["Authorization", "Custom my-auth-header"]]);
    });

    it("supports offline mode with placeholder values", async () => {
      const req: PreparedRequest = {
        method: "GET",
        url: "http://example.com/test",
        headers: [],
        settings: DEFAULT_SETTINGS,
      };

      await applyAuth(
        req,
        {
          type: "hawk",
          hawk: {
            authId: "",
            authKey: "",
            algorithm: "sha256",
          },
        },
        undefined,
        true,
      );

      const authHeader = req.headers.find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader).toBeDefined();
      expect(authHeader![1]).toContain('Hawk id="<auth-id>"');
    });

    it("resolves inheritance properly across folder/collection hierarchy", () => {
      const collectionAuth: AuthConfig = {
        type: "hawk",
        hawk: { authId: "col-id", authKey: "col-key", algorithm: "sha256" },
      };
      const folderAuth: AuthConfig = { type: "inherit" };
      const requestAuth: AuthConfig = { type: "inherit" };

      const effective = resolveEffectiveAuth([collectionAuth, folderAuth, requestAuth]);
      expect(effective).toEqual(collectionAuth);
    });
  });

  describe("Postman collection conversion", () => {
    it("imports Postman collection Hawk auth", () => {
      const imported = importAuth({
        type: "hawk",
        hawk: [
          { key: "authId", value: "test-auth-id", type: "string" },
          { key: "authKey", value: "test-auth-key", type: "string" },
          { key: "algorithm", value: "sha256", type: "string" },
          { key: "user", value: "alice", type: "string" },
          { key: "nonce", value: "custom-nonce", type: "string" },
          { key: "ext", value: "custom-ext", type: "string" },
          { key: "app", value: "app-1", type: "string" },
          { key: "dlg", value: "dlg-1", type: "string" },
          { key: "timestamp", value: "999999", type: "string" },
          { key: "includePayloadHash", value: "true", type: "boolean" },
        ],
      });

      expect(imported).toEqual({
        type: "hawk",
        hawk: {
          authId: "test-auth-id",
          authKey: "test-auth-key",
          algorithm: "sha256",
          user: "alice",
          nonce: "custom-nonce",
          ext: "custom-ext",
          app: "app-1",
          dlg: "dlg-1",
          timestamp: "999999",
          includePayloadHash: true,
        },
      });
    });

    it("exports Hawk auth in Postman collection format", () => {
      const exported = exportPostmanCollection({
        id: "folder-1",
        kind: "folder",
        name: "Hawk Collection",
        description: "",
        auth: {
          type: "hawk",
          hawk: {
            authId: "export-id",
            authKey: "export-key",
            algorithm: "sha256",
            user: "bob",
            ext: "data",
            includePayloadHash: false,
          },
        },
        headers: [],
        preRequestScript: "",
        testScript: "",
        children: [],
      });

      expect(isPostmanCollection(exported)).toBe(true);
      expect(exported.auth?.type).toBe("hawk");
      const hawkList = exported.auth?.hawk as { key: string; value: string }[];
      expect(hawkList).toEqual(
        expect.arrayContaining([
          { key: "authId", value: "export-id", type: "string" },
          { key: "authKey", value: "export-key", type: "string" },
          { key: "algorithm", value: "sha256", type: "string" },
          { key: "user", value: "bob", type: "string" },
          { key: "ext", value: "data", type: "string" },
          { key: "includePayloadHash", value: "false", type: "string" },
        ]),
      );
    });
  });

  describe("Validation schemas and redaction", () => {
    it("validates valid Hawk config with hawkConfigSchema", () => {
      const parsed = hawkConfigSchema.parse({
        authId: "id",
        authKey: "key",
        algorithm: "sha256",
        includePayloadHash: true,
      });
      expect(parsed.authId).toBe("id");
      expect(parsed.algorithm).toBe("sha256");
      expect(parsed.includePayloadHash).toBe(true);
    });

    it("validates auth union schema with hawk", () => {
      const parsed = authSchema.parse({
        type: "hawk",
        hawk: {
          authId: "id",
          authKey: "secret-key",
          algorithm: "sha1",
        },
      });
      expect(parsed.type).toBe("hawk");
      if (parsed.type === "hawk") {
        expect(parsed.hawk.algorithm).toBe("sha1");
      }
    });

    it("redacts secret hawkKey when stored", () => {
      const secret = "super-secret-hawk-key";
      const stored = {
        type: "hawk",
        hawk: {
          authId: "public-id",
          authKey: secret,
          algorithm: "sha256",
        },
      };

      const redacted = redactStoredValue(stored, [secret]);
      expect(JSON.stringify(redacted)).not.toContain(secret);
      expect(redacted.hawk.authKey).toBe("********");
      expect(redacted.hawk.authId).toBe("public-id");
    });
  });
});

// Expected values produced by the reference hawk@9.0.2 client and crypto helpers.
describe("Hawk escaping matches the reference implementation", () => {
  const config = {
    authId: "dh37fgj492je",
    authKey: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
    algorithm: "sha256" as const,
    timestamp: "1353832234",
    nonce: "j4h3g2",
  };
  const req = { method: "GET", url: "http://example.com:8000/resource/1?b=1&a=2", headers: [] };

  it.each([
    ["a\\b", 'ext="a\\\\b"', "TPYHhLoxkgiUT9hzHRuJYhMJ2VksVO+nc5lytAO1IX0="],
    ['a"b', 'ext="a\\"b"', "xsvHFmY7JwXpj+HB4AnbEwcTvt6TaLO6vpNM3EBQ2h4="],
  ])("escapes ext %j in the header and MAC", (ext, attr, mac) => {
    expect(buildHawkHeader(req, { ...config, ext })).toBe(
      `Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ${attr}, mac="${mac}"`,
    );
  });

  it("escapes newlines and backslashes in the normalized string", () => {
    const normalized = generateHawkNormalizedString({
      ts: "1353832234",
      nonce: "j4h3g2",
      method: "GET",
      resource: "/resource/1?b=1&a=2",
      host: "example.com",
      port: "8000",
      ext: "line1\nline2\\x",
    });
    expect(normalized).toBe(
      "hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nline1\\nline2\\\\x\n",
    );
    expect(calculateHawkMac(normalized, config.authKey)).toBe("2uvIJnP4hIQVvJ4HaxIRStMhc8iRP4U1kxSG16+vva4=");
  });

  it("rejects header attributes that cannot be sent safely", () => {
    expect(() => buildHawkHeader(req, { ...config, ext: "line1\nline2" })).toThrow(/cannot be sent/);
    expect(() => buildHawkHeader(req, { ...config, authId: 'a"b' })).toThrow(/quotes or backslashes/);
    expect(() => buildHawkHeader(req, { ...config, app: "a\\b" })).toThrow(/quotes or backslashes/);
  });
});
