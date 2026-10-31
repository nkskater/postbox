import { describe, expect, it } from "vitest";
import { constants, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createAsapToken, parseExpiry } from "@/core/http/asap";
import { applyAuth, resolveAuth, resolveEffectiveAuth } from "@/core/http/auth";
import { exportPostmanCollection, importPostmanCollection } from "@/core/convert/postman";
import { authCredentialValues, restoreMissingCredentials, withoutAuthCredentials } from "@/core/retention";
import { authSchema } from "@/core/schemas";
import { Resolver } from "@/core/variables/resolver";
import type { AsapAlgorithm, AsapConfig, AuthConfig, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const curves = { ES256: "P-256", ES384: "P-384", ES512: "P-521" } as const;
const ec = Object.fromEntries(
  Object.entries(curves).map(([alg, namedCurve]) => [alg, generateKeyPairSync("ec", { namedCurve })]),
) as Record<keyof typeof curves, { privateKey: KeyObject; publicKey: KeyObject }>;
const pem = (k: KeyObject) => k.export({ type: "pkcs8", format: "pem" }).toString();

const base: AsapConfig = {
  issuer: "svc-a",
  subject: "user-1",
  audience: "svc-b",
  keyId: "svc-a/key-1",
  privateKey: pem(rsa.privateKey),
};

function decode(token: string) {
  const [h, c, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    input: `${h}.${c}`,
    signature: Buffer.from(s, "base64url"),
  };
}

describe("ASAP tokens", () => {
  it("issues the ASAP claims and header", () => {
    const now = Date.UTC(2026, 0, 1);
    const { token } = createAsapToken(
      { ...base, expiry: "30m", additionalClaims: '{"scope":"read"}' },
      now,
      "id-1",
    );
    const { header, claims } = decode(token);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "svc-a/key-1" });
    expect(claims).toEqual({
      scope: "read",
      iss: "svc-a",
      sub: "user-1",
      aud: "svc-b",
      jti: "id-1",
      iat: now / 1000,
      exp: now / 1000 + 1800,
    });
    expect(decode(createAsapToken({ ...base, audience: "b, c" }).token).claims.aud).toEqual(["b", "c"]);
    expect(decode(createAsapToken(base).token).claims.jti).not.toBe(
      decode(createAsapToken(base).token).claims.jti,
    );
  });

  it.each(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"] as const)(
    "%s verifies with the public key",
    (alg) => {
      const parts = decode(createAsapToken({ ...base, algorithm: alg }).token);
      expect(parts.header.alg).toBe(alg);
      const ok = verify(
        `sha${alg.slice(2)}`,
        Buffer.from(parts.input),
        alg.startsWith("PS")
          ? {
              key: rsa.publicKey,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            }
          : rsa.publicKey,
        parts.signature,
      );
      expect(ok).toBe(true);
    },
  );

  it.each(Object.keys(curves) as (keyof typeof curves)[])("%s verifies with the public key", (alg) => {
    const parts = decode(
      createAsapToken({ ...base, algorithm: alg as AsapAlgorithm, privateKey: pem(ec[alg].privateKey) })
        .token,
    );
    const ok = verify(
      `sha${alg.slice(2)}`,
      Buffer.from(parts.input),
      { key: ec[alg].publicKey, dsaEncoding: "ieee-p1363" },
      parts.signature,
    );
    expect(ok).toBe(true);
  });

  it("enforces expiry limits and required fields", () => {
    expect(parseExpiry(undefined)).toBe(3600);
    expect(parseExpiry("90")).toBe(90);
    expect(parseExpiry("2m")).toBe(120);
    expect(() => parseExpiry("2h")).toThrow(/within/);
    expect(() => parseExpiry("soon")).toThrow(/duration/);
    expect(() => createAsapToken({ ...base, issuer: "" })).toThrow(/issuer/);
    expect(() => createAsapToken({ ...base, audience: " , " })).toThrow(/audience/);
    expect(() => createAsapToken({ ...base, keyId: "../etc/passwd" })).toThrow(/key ID/);
    expect(() => createAsapToken({ ...base, privateKey: "nope" })).toThrow(/could not be read/);
    expect(() => createAsapToken({ ...base, algorithm: "ES256" })).toThrow(/EC private key/);
    expect(() => createAsapToken({ ...base, additionalClaims: '{"exp": 1}' })).toThrow(/cannot set exp/);
    expect(() => createAsapToken({ ...base, additionalClaims: "[1]" })).toThrow(/JSON object/);
  });
});

describe("ASAP auth integration", () => {
  const auth: AuthConfig = { type: "asap", asap: { ...base, privateKey: "{{asapKey}}" } };

  it("inherits, resolves a secret key reference and sends a Bearer token", async () => {
    const resolved = resolveAuth(
      resolveEffectiveAuth([auth, { type: "inherit" }]),
      new Resolver({
        globals: { asapKey: base.privateKey },
        environment: {},
        collection: {},
        data: {},
        local: {},
      }),
    );
    const req: PreparedRequest = {
      method: "GET",
      url: "https://svc-b/",
      headers: [],
      settings: DEFAULT_SETTINGS,
    };
    await applyAuth(req, resolved);
    const value = req.headers.find(([k]) => k === "Authorization")?.[1] ?? "";
    expect(value).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decode(value.slice(7)).claims.iss).toBe("svc-a");
    expect(authSchema.parse(auth)).toMatchObject({ type: "asap" });
  });

  it("uses a placeholder for code generation when the key is unresolved", async () => {
    const req: PreparedRequest = {
      method: "GET",
      url: "https://svc-b/",
      headers: [],
      settings: DEFAULT_SETTINGS,
    };
    await applyAuth(req, auth, undefined, true);
    expect(req.headers).toContainEqual(["Authorization", "Bearer <asap-token>"]);
    await expect(applyAuth({ ...req, headers: [] }, auth)).rejects.toThrow(/private key/);
  });

  it("round-trips Postman asap auth without exporting or retaining the key", () => {
    const col = importPostmanCollection({
      info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      auth: {
        type: "asap",
        asap: [
          { key: "alg", value: "PS256" },
          { key: "issuer", value: "svc-a" },
          { key: "audience", value: "svc-b" },
          { key: "kid", value: "svc-a/key-1" },
          { key: "privateKey", value: "PEMSECRET" },
          { key: "exp", value: "10m" },
          { key: "claims", value: { scope: "x" } },
        ],
      },
      item: [],
    } as never);
    expect(col.root.auth).toEqual({
      type: "asap",
      asap: {
        algorithm: "PS256",
        issuer: "svc-a",
        audience: "svc-b",
        keyId: "svc-a/key-1",
        privateKey: "PEMSECRET",
        expiry: "10m",
        additionalClaims: '{"scope":"x"}',
      },
    });
    expect(JSON.stringify(exportPostmanCollection(col.root))).not.toContain("PEMSECRET");
    expect(JSON.stringify(exportPostmanCollection(col.root, [], { includeCredentials: true }))).toContain(
      "PEMSECRET",
    );
    expect(authCredentialValues(col.root.auth)).toEqual(["PEMSECRET"]);
    const stripped = withoutAuthCredentials(col.root.auth);
    expect(JSON.stringify(stripped)).not.toContain("PEMSECRET");
    expect(restoreMissingCredentials(stripped, col.root.auth)).toEqual(col.root.auth);
  });
});
