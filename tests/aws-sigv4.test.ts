import { describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { canonicalPath, signAwsRequest } from "@/core/http/aws-sigv4";
import { applyAuth, resolveAuth } from "@/core/http/auth";
import { sendRequest } from "@/core/http/engine";
import { exportPostmanCollection, importAuth, importPostmanCollection } from "@/core/convert/postman";
import { authCredentialValues, restoreMissingCredentials, withoutAuthCredentials } from "@/core/retention";
import { authSchema } from "@/core/schemas";
import { Resolver } from "@/core/variables/resolver";
import type { AuthConfig, AwsSigV4Config, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const SUITE = path.join(__dirname, "fixtures/aws-sig-v4-test-suite");
const credentials: AwsSigV4Config = {
  accessKey: "AKIDEXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};
/**
 * Skipped suite cases:
 * - get-space / get-utf8 put raw spaces and UTF-8 bytes in the request line, which a URL cannot carry;
 *   real clients send them percent-encoded and non-S3 services then encode the path a second time.
 * - post-sts-header-after adds the token after signing; Postbox always signs it (header-before).
 */
const SKIP = new Set(["get-space", "get-utf8", "post-sts-header-after"]);

function suiteCases(dir = SUITE): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory()) return [];
    const full = path.join(dir, e.name);
    return fs.existsSync(path.join(full, `${e.name}.req`)) ? [full] : suiteCases(full);
  });
}

function parseRequest(raw: string) {
  const [head, ...rest] = raw.split("\n\n");
  const [requestLine, ...lines] = head.split("\n");
  const m = /^(\S+) (.*) HTTP\/1\.1$/.exec(requestLine)!;
  const headers: [string, string][] = [];
  for (const line of lines) {
    if (/^\s/.test(line)) headers.push([headers.at(-1)![0], line.trim()]);
    else {
      const i = line.indexOf(":");
      headers.push([line.slice(0, i), line.slice(i + 1)]);
    }
  }
  const host = headers.find(([k]) => k.toLowerCase() === "host")![1];
  return { method: m[1], url: `https://${host}${m[2]}`, headers, body: rest.join("\n\n") || undefined };
}

describe("AWS Signature V4 test suite", () => {
  const cases = suiteCases().filter((dir) => !SKIP.has(path.basename(dir)));
  it("finds the suite", () => expect(cases.length).toBeGreaterThan(25));

  it.each(cases.map((dir) => [path.basename(dir), dir]))("%s", (name, dir) => {
    const req = parseRequest(fs.readFileSync(path.join(dir, `${name}.req`), "utf8"));
    const header = (n: string) => req.headers.find(([k]) => k.toLowerCase() === n)?.[1];
    const signed = signAwsRequest(req, {
      ...credentials,
      timestamp: header("x-amz-date"),
      sessionToken: header("x-amz-security-token"),
    });
    expect(signed.parts.canonicalRequest).toBe(fs.readFileSync(path.join(dir, `${name}.creq`), "utf8"));
    expect(signed.headers.find(([k]) => k === "Authorization")?.[1]).toBe(
      fs.readFileSync(path.join(dir, `${name}.authz`), "utf8"),
    );
  });
});

describe("AWS Signature canonicalization", () => {
  it("encodes non-S3 paths a second time and S3 paths once", () => {
    expect(canonicalPath("/a%20b/c", "execute-api")).toBe("/a%2520b/c");
    expect(canonicalPath("/a%20b//./c", "s3")).toBe("/a%20b//./c");
    expect(canonicalPath("/a//b/./c/../d", "lambda")).toBe("/a/b/d");
  });

  it("signs S3 requests with an x-amz-content-sha256 header", () => {
    const signed = signAwsRequest(
      {
        method: "PUT",
        url: "https://bucket.s3.amazonaws.com/my%20file.txt",
        headers: [],
        body: Buffer.from("hi"),
      },
      { ...credentials, service: "s3", timestamp: "20150830T123600Z" },
    );
    const hash = signed.headers.find(([k]) => k === "X-Amz-Content-Sha256")?.[1];
    expect(hash).toBe("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
    expect(signed.parts.canonicalRequest.split("\n")[1]).toBe("/my%20file.txt");
    expect(signed.parts.signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
  });

  it("presigns URLs in query mode", () => {
    const signed = signAwsRequest(
      { method: "GET", url: "https://example.amazonaws.com/?Param1=value1", headers: [] },
      {
        ...credentials,
        addTo: "query",
        expiresSeconds: 60,
        timestamp: "20150830T123600Z",
        sessionToken: "tok/en",
      },
    );
    const u = new URL(signed.url);
    expect(u.searchParams.get("X-Amz-Credential")).toBe(
      "AKIDEXAMPLE/20150830/us-east-1/service/aws4_request",
    );
    expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(u.searchParams.get("X-Amz-Security-Token")).toBe("tok/en");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get("Param1")).toBe("value1");
    expect(signed.headers.some(([k]) => k.toLowerCase() === "authorization")).toBe(false);
    // Signing again replaces the previous signature instead of stacking parameters.
    const again = signAwsRequest(
      { ...signed },
      { ...credentials, addTo: "query", timestamp: "20150830T123600Z" },
    );
    expect(new URL(again.url).searchParams.getAll("X-Amz-Signature")).toHaveLength(1);
  });

  it("rejects missing credentials, service and bad timestamps", () => {
    const req = { method: "GET", url: "https://example.com/", headers: [] as [string, string][] };
    expect(() => signAwsRequest(req, { ...credentials, secretKey: "" })).toThrow(/secret key/);
    expect(() => signAwsRequest(req, { ...credentials, service: "" })).toThrow(/service/);
    expect(() => signAwsRequest(req, { ...credentials, timestamp: "yesterday" })).toThrow(/timestamp/);
  });
});

describe("AWS Signature auth integration", () => {
  const auth: AuthConfig = {
    type: "awsv4",
    awsv4: {
      ...credentials,
      secretKey: "{{secret}}",
      sessionToken: "{{token}}",
      timestamp: "20150830T123600Z",
    },
  };

  it("resolves variables and signs the final request", async () => {
    const resolved = resolveAuth(
      auth,
      new Resolver({
        globals: { secret: credentials.secretKey, token: "T" },
        environment: {},
        collection: {},
        data: {},
        local: {},
      }),
    );
    const req: PreparedRequest = {
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: [],
      settings: DEFAULT_SETTINGS,
    };
    await applyAuth(req, resolved);
    expect(req.headers.find(([k]) => k === "X-Amz-Security-Token")?.[1]).toBe("T");
    expect(req.headers.find(([k]) => k === "Authorization")?.[1]).toMatch(
      /SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(req.awsv4?.secretKey).toBe(credentials.secretKey);
  });

  it("validates, imports and exports Postman awsv4 auth without leaking secrets", () => {
    expect(authSchema.parse(auth)).toMatchObject({ type: "awsv4" });
    const imported = importAuth({
      type: "awsv4",
      awsv4: [
        { key: "accessKey", value: "AK" },
        { key: "secretKey", value: "SK" },
        { key: "region", value: "eu-west-1" },
        { key: "service", value: "execute-api" },
        { key: "sessionToken", value: "ST" },
        { key: "addAuthDataToQuery", value: true },
      ],
    } as never);
    expect(imported).toEqual({
      type: "awsv4",
      awsv4: {
        accessKey: "AK",
        secretKey: "SK",
        sessionToken: "ST",
        region: "eu-west-1",
        service: "execute-api",
        addTo: "query",
      },
    });
    const col = importPostmanCollection({
      info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      auth: {
        type: "awsv4",
        awsv4: [
          { key: "accessKey", value: "AK" },
          { key: "secretKey", value: "SK" },
          { key: "service", value: "s3" },
          { key: "sessionToken", value: "ST" },
        ],
      },
      item: [],
    } as never);
    const exported = JSON.stringify(exportPostmanCollection(col.root));
    expect(exported).toContain('"awsv4"');
    expect(exported).not.toContain('"SK"');
    expect(exported).not.toContain('"ST"');
    expect(authCredentialValues(imported)).toEqual(["SK", "ST"]);
    const stripped = withoutAuthCredentials(imported);
    expect(stripped).toMatchObject({ awsv4: { secretKey: "", sessionToken: "" } });
    expect(restoreMissingCredentials(stripped, imported)).toEqual(imported);
  });

  it("re-signs same-origin redirects and drops credentials on cross-origin redirects", async () => {
    const seen: { url: string; auth?: string; token?: string }[] = [];
    const other = http.createServer((req, res) => {
      seen.push({
        url: `other${req.url}`,
        auth: req.headers.authorization,
        token: req.headers["x-amz-security-token"] as string,
      });
      res.end("ok");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const main = http.createServer((req, res) => {
      seen.push({
        url: req.url!,
        auth: req.headers.authorization,
        token: req.headers["x-amz-security-token"] as string,
      });
      if (req.url === "/start") res.writeHead(302, { Location: "/next" }).end();
      else res.writeHead(302, { Location: `${otherUrl}/away` }).end();
    });
    await new Promise<void>((r) => main.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;
    try {
      const req: PreparedRequest = {
        method: "GET",
        url: `${base}/start`,
        headers: [],
        settings: DEFAULT_SETTINGS,
      };
      await applyAuth(req, { type: "awsv4", awsv4: { ...credentials, sessionToken: "SECRET-TOKEN" } });
      await sendRequest(req);
      expect(seen.map((s) => s.url)).toEqual(["/start", "/next", "other/away"]);
      expect(seen[0].auth).toMatch(/^AWS4-HMAC-SHA256/);
      expect(seen[1].auth).toMatch(/^AWS4-HMAC-SHA256/);
      expect(seen[1].auth).not.toBe(seen[0].auth);
      expect(seen[2].auth).toBeUndefined();
      expect(seen[2].token).toBeUndefined();
    } finally {
      main.close();
      other.close();
    }
  });

  it("strips Hawk and EdgeGrid secrets from drafts too", () => {
    const hawk: AuthConfig = { type: "hawk", hawk: { authId: "id", authKey: "HK", algorithm: "sha256" } };
    const edgegrid: AuthConfig = {
      type: "edgegrid",
      edgegrid: { clientToken: "CT", clientSecret: "CS", accessToken: "AT" },
    };
    expect(authCredentialValues(hawk)).toEqual(["HK"]);
    expect(authCredentialValues(edgegrid).sort()).toEqual(["AT", "CS", "CT"]);
    expect(JSON.stringify(withoutAuthCredentials(hawk))).not.toContain("HK");
    expect(JSON.stringify(withoutAuthCredentials(edgegrid))).not.toMatch(/CT|CS|AT/);
    expect(restoreMissingCredentials(withoutAuthCredentials(edgegrid), edgegrid)).toEqual(edgegrid);
  });
});
