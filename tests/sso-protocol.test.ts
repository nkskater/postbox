import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { providerInput, safeNext } from "@/core/sso/model";
import {
  callbackUrl,
  oidcConfiguration,
  oidcStart,
  oidcFinish,
  samlClient,
  samlIdentity,
} from "@/core/sso/protocol";
import type { CacheProvider } from "@node-saml/node-saml";
import { fakeOidc } from "./helpers/sso-idp";
let idp: Awaited<ReturnType<typeof fakeOidc>>;
beforeAll(async () => {
  idp = await fakeOidc();
});
afterAll(async () => {
  await idp.close();
});
const correlation = {
  verifier: "fixture-verifier-with-at-least-43-characters-000",
  nonce: "nonce-value",
  requestId: "_fixture-request",
};
const state = "expected-state",
  callback = "http://localhost:7777/api/auth/sso/fixture/callback";
async function oidcLogin(
  overrides: Record<string, unknown> = {},
  badSignature = false,
  checks = correlation,
  expectedState = state,
) {
  idp.setClaims(overrides, badSignature);
  const p = providerInput.parse({
    kind: "oidc",
    name: "Fixture",
    origin: "http://localhost:7777",
    issuer: idp.issuer,
    clientId: "fixture-client",
    clientAuth: "none",
  });
  if (p.kind !== "oidc") throw new Error();
  const config = await oidcConfiguration(p, {}, (url, options) => fetch(url, options as RequestInit));
  const authorize = await oidcStart(config, callback, state, correlation);
  const response = await fetch(authorize, { redirect: "manual" });
  return oidcFinish(config, new URL(response.headers.get("location")!), expectedState, checks);
}
describe("OIDC signature and correlation verification", () => {
  it("verifies signed tokens with PKCE, state, nonce, issuer and audience", async () => {
    expect((await oidcLogin()).subject).toBe("subject-123");
  });
  it.each([{ aud: "other-client" }, { iss: "https://wrong.example" }, { exp: 1 }, { nonce: "wrong" }])(
    "rejects wrong signed claims %j",
    async (claim) => {
      await expect(oidcLogin(claim)).rejects.toThrow();
    },
  );
  it("rejects a forged signature even when the token endpoint is trusted", async () => {
    await expect(oidcLogin({}, true)).rejects.toThrow();
  });
  it("rejects wrong state and PKCE verifier", async () => {
    await expect(oidcLogin({}, false, correlation, "wrong-state")).rejects.toThrow();
    await expect(oidcLogin({}, false, { ...correlation, verifier: "wrong-verifier" })).rejects.toThrow();
  });
});
const key = readFileSync("tests/fixtures/tls/localhost-key.pem", "utf8"),
  cert = readFileSync("tests/fixtures/tls/localhost-cert.pem", "utf8");
const samlConfig = providerInput.parse({
  kind: "saml",
  name: "SAML Fixture",
  origin: "https://postbox.example",
  entryPoint: "https://idp.example/login",
  idpIssuer: "https://idp.example",
  entityId: "postbox-sp",
  idpCert: cert,
});
function memoryCache(): CacheProvider {
  const values = new Map<string, string>();
  return {
    async saveAsync(k, v) {
      values.set(k, v);
      return { value: v, createdAt: Date.now() };
    },
    async getAsync(k) {
      return values.get(k) ?? null;
    },
    async removeAsync(k) {
      const v = k ? values.get(k) : null;
      if (k) values.delete(k);
      return v ?? null;
    },
    async consumeAsync(k) {
      const v = values.get(k);
      values.delete(k);
      return v ?? null;
    },
    async saveIfAbsentAsync(k, v) {
      if (values.has(k)) return false;
      values.set(k, v);
      return true;
    },
  };
}
function signElement(xml: string, element: string) {
  const signer = new SignedXml({
    privateKey: key,
    publicCert: cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: `//*[local-name()='${element}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: "after" },
  });
  return signer.getSignedXml();
}
function samlResponse(
  options: {
    audience?: string;
    recipient?: string;
    issuer?: string;
    expires?: string;
    unsigned?: boolean;
    tamper?: boolean;
    requestId?: string;
    assertionId?: string;
  } = {},
) {
  const now = new Date().toISOString(),
    expires = options.expires ?? new Date(Date.now() + 240000).toISOString(),
    cb = callbackUrl(samlConfig, "fixture");
  const issuer = options.issuer ?? "https://idp.example",
    requestId = options.requestId ?? correlation.requestId;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${now}" Destination="${cb}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${options.assertionId ?? "_assertion"}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">saml-subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${options.recipient ?? cb}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(Date.now() - 30000).toISOString()}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? "postbox-sp"}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="fixture-session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="name"><saml:AttributeValue>Signed Person</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>developers</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  if (!options.unsigned) {
    xml = signElement(xml, "Assertion");
    xml = signElement(xml, "Response");
  }
  if (options.tamper) xml = xml.replace("saml-subject", "forged-subject");
  return Buffer.from(xml).toString("base64");
}
async function samlLogin(options: Parameters<typeof samlResponse>[0] = {}, cache = memoryCache()) {
  if (samlConfig.kind !== "saml") throw new Error();
  const cb = callbackUrl(samlConfig, "fixture"),
    client = samlClient(samlConfig, {}, cb, correlation, cache);
  const url = new URL(await client.getAuthorizeUrlAsync("state", undefined));
  expect(inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString()).toContain(
    correlation.requestId,
  );
  const result = await client.validatePostResponseAsync({ SAMLResponse: samlResponse(options) });
  return samlIdentity(result.profile, cb, correlation.requestId);
}
describe("SAML signed assertions and login binding", () => {
  it("accepts correctly signed correlated responses", async () => {
    expect((await samlLogin()).subject).toBe("saml-subject");
  });
  it.each([
    { audience: "wrong" },
    { issuer: "https://wrong.example" },
    { recipient: "https://attacker.example" },
    { requestId: "_unknown" },
    { unsigned: true },
    { tamper: true },
    { expires: "2000-01-01T00:00:00Z" },
  ])("rejects invalid SAML %j", async (options) => {
    await expect(samlLogin(options)).rejects.toThrow();
  });
  it("rejects assertion replay even with a fresh request cache entry", async () => {
    const cache = memoryCache();
    await samlLogin({}, cache);
    await expect(samlLogin({}, cache)).rejects.toThrow();
  });
});
it("rejects unsafe return paths and insecure remote IdPs", () => {
  for (const next of ["//evil.example", "/\\evil.example", "/\n/evil", "https://evil.example"])
    expect(safeNext(next)).toBe("/");
  expect(safeNext("/profile?tab=tokens")).toBe("/profile?tab=tokens");
  expect(
    providerInput.safeParse({
      kind: "oidc",
      name: "X",
      origin: "https://postbox.example",
      issuer: "http://idp.example",
      clientId: "client",
    }).success,
  ).toBe(false);
});
