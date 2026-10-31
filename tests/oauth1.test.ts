import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { baseStringUri, oauthEncode, signOAuth1Request } from "@/core/http/oauth1";
import { applyAuth, resolveAuth, resolveEffectiveAuth } from "@/core/http/auth";
import { exportPostmanCollection, importPostmanCollection } from "@/core/convert/postman";
import { authCredentialValues, restoreMissingCredentials, withoutAuthCredentials } from "@/core/retention";
import { authSchema } from "@/core/schemas";
import { Resolver } from "@/core/variables/resolver";
import type { AuthConfig, OAuth1Config, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const form: [string, string][] = [["Content-Type", "application/x-www-form-urlencoded"]];
const header = (headers: [string, string][]) => headers.find(([k]) => k === "Authorization")?.[1];

describe("OAuth 1.0 signature base string (RFC 5849)", () => {
  it("matches the RFC 5849 section 3.4.1.1 example", () => {
    const signed = signOAuth1Request(
      {
        method: "POST",
        url: "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
        headers: form,
        body: Buffer.from("c2&a3=2+q"),
      },
      {
        consumerKey: "9djdj82h48djs9d2",
        consumerSecret: "j49sk3j29djd",
        token: "kkk9d7dh3k39sjv7",
        tokenSecret: "dh893hdasih9",
        timestamp: "137131201",
        nonce: "7d8f3e4a",
        version: "",
        realm: "Example",
      },
    );
    expect(signed.baseString).toBe(
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q" +
        "%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_" +
        "key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m" +
        "ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk" +
        "9d7dh3k39sjv7",
    );
    expect(header(signed.headers)).toMatch(/^OAuth realm="Example",oauth_consumer_key="9djdj82h48djs9d2",/);
  });

  it("normalizes the base string URI", () => {
    expect(baseStringUri(new URL("HTTP://EXAMPLE.COM:80/r%20v/X?id=123"))).toBe("http://example.com/r%20v/X");
    expect(baseStringUri(new URL("https://www.example.net:8080/?q=1"))).toBe("https://www.example.net:8080/");
    expect(oauthEncode("Ladies + Gentlemen *!'()")).toBe("Ladies%20%2B%20Gentlemen%20%2A%21%27%28%29");
  });
});

describe("OAuth 1.0 signatures", () => {
  const base: OAuth1Config = {
    consumerKey: "ck",
    consumerSecret: "c s&e",
    token: "tk",
    tokenSecret: "ts!",
    timestamp: "1700000000",
    nonce: "n0nce",
  };
  const req = {
    method: "POST",
    url: "https://api.example.com/a%20b/c?x=1&y=%2Bz",
    headers: form,
    body: Buffer.from("f=v+w&g="),
  };

  // Expected values produced by the oauth-1.0a@2.2.6 package for the same request.
  it.each([
    ["HMAC-SHA1", "O6zPznAh7jZ2JL0HE9s5JVaIJak="],
    ["HMAC-SHA256", "fDNgOJ+2mZMm6Apv7UcuDVdho1p0UVDJVZ2QlOrqqps="],
    [
      "HMAC-SHA512",
      "taeVXnRCITWC3cfKd0dj8uF0WCbQtYkLtEaQLyuXzEGsPfW4XqFLt5EqA1X6HS1n9jjLpDzz/urSP4zWjoChRw==",
    ],
  ] as const)("%s", (signatureMethod, expected) => {
    expect(signOAuth1Request(req, { ...base, signatureMethod }).signature).toBe(expected);
  });

  it("PLAINTEXT sends the encoded secrets", () => {
    expect(signOAuth1Request(req, { ...base, signatureMethod: "PLAINTEXT" }).signature).toBe(
      "c%20s%26e&ts%21",
    );
  });

  it.each(["RSA-SHA1", "RSA-SHA256", "RSA-SHA512"] as const)(
    "%s verifies with the public key",
    (signatureMethod) => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const signed = signOAuth1Request(req, {
        ...base,
        signatureMethod,
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      });
      const verifier = createVerify(`RSA-${signatureMethod.slice(4)}`).update(signed.baseString);
      expect(verifier.verify(publicKey, signed.signature, "base64")).toBe(true);
      expect(() => signOAuth1Request(req, { ...base, signatureMethod })).toThrow(/private key/);
    },
  );

  it("places parameters in the query or form body and adds the body hash", () => {
    const q = signOAuth1Request(
      { ...req, headers: [], body: undefined, method: "GET" },
      { ...base, addTo: "query" },
    );
    const params = new URL(q.url).searchParams;
    expect(params.get("x")).toBe("1");
    expect(params.get("oauth_signature")).toBe(q.signature);
    expect(header(q.headers)).toBeUndefined();

    const b = signOAuth1Request(req, { ...base, addTo: "body" });
    expect(b.body!.toString()).toMatch(/^f=v\+w&g=&oauth_consumer_key=ck&.*oauth_signature=/);
    expect(() =>
      signOAuth1Request(
        { ...req, headers: [["Content-Type", "application/json"]] },
        { ...base, addTo: "body" },
      ),
    ).toThrow(/form-urlencoded/);

    const json = signOAuth1Request(
      { ...req, headers: [["Content-Type", "application/json"]], body: Buffer.from("{}") },
      { ...base, includeBodyHash: true },
    );
    // base64(sha1("{}"))
    expect(header(json.headers)).toContain('oauth_body_hash="vyGp6PvFo4RvsFtPoIWeCReyIC8%3D"');
  });

  it("includes callback and verifier for the three-legged flow", () => {
    const signed = signOAuth1Request(req, { ...base, callback: "https://app/cb", verifier: "v123" });
    expect(header(signed.headers)).toContain('oauth_callback="https%3A%2F%2Fapp%2Fcb"');
    expect(header(signed.headers)).toContain('oauth_verifier="v123"');
    expect(signed.baseString).toContain("oauth_verifier%3Dv123");
  });
});

describe("OAuth 1.0 auth integration", () => {
  const auth: AuthConfig = {
    type: "oauth1",
    oauth1: {
      consumerKey: "{{ck}}",
      consumerSecret: "{{cs}}",
      tokenSecret: "TS",
      timestamp: "1",
      nonce: "n",
    },
  };

  it("inherits, resolves variables and signs the prepared request", async () => {
    const effective = resolveEffectiveAuth([auth, { type: "inherit" }]);
    const resolved = resolveAuth(
      effective,
      new Resolver({
        globals: { ck: "key", cs: "sec" },
        environment: {},
        collection: {},
        data: {},
        local: {},
      }),
    );
    const req: PreparedRequest = {
      method: "GET",
      url: "https://example.com/",
      headers: [],
      settings: DEFAULT_SETTINGS,
    };
    await applyAuth(req, resolved);
    expect(header(req.headers)).toMatch(/^OAuth oauth_consumer_key="key",/);
    expect(authSchema.parse(auth)).toMatchObject({ type: "oauth1" });
  });

  it("round-trips Postman oauth1 auth and keeps secrets out of default exports and drafts", () => {
    const col = importPostmanCollection({
      info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      auth: {
        type: "oauth1",
        oauth1: [
          { key: "consumerKey", value: "CK" },
          { key: "consumerSecret", value: "CS" },
          { key: "token", value: "TK" },
          { key: "tokenSecret", value: "TSECRET" },
          { key: "signatureMethod", value: "HMAC-SHA256" },
          { key: "addParamsToHeader", value: false },
          { key: "realm", value: "R" },
        ],
      },
      item: [],
    } as never);
    expect(col.root.auth).toMatchObject({
      type: "oauth1",
      oauth1: {
        consumerKey: "CK",
        consumerSecret: "CS",
        signatureMethod: "HMAC-SHA256",
        addTo: "query",
        realm: "R",
      },
    });
    const exported = JSON.stringify(exportPostmanCollection(col.root));
    expect(exported).toContain('"oauth1"');
    expect(exported).not.toMatch(/"CS"|"TSECRET"/);
    expect(JSON.stringify(exportPostmanCollection(col.root, [], { includeCredentials: true }))).toContain(
      '"TSECRET"',
    );

    expect(authCredentialValues(col.root.auth)).toEqual(["CS", "TSECRET"]);
    const stripped = withoutAuthCredentials(col.root.auth);
    expect(JSON.stringify(stripped)).not.toMatch(/"CS"|"TSECRET"/);
    expect(restoreMissingCredentials(stripped, col.root.auth)).toEqual(col.root.auth);
  });
});
