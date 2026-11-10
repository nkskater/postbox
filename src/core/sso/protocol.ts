import * as oidc from "openid-client";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import type { Provider, ProviderSecrets, VerifiedIdentity } from "./model";
export interface Correlation {
  verifier: string;
  nonce: string;
  requestId: string;
}
export function callbackUrl(p: Provider, id: string) {
  return `${p.origin}/api/auth/sso/${encodeURIComponent(id)}/callback`;
}
export async function oidcConfiguration(
  p: Extract<Provider, { kind: "oidc" }>,
  secrets: ProviderSecrets,
  fetcher: oidc.CustomFetch,
) {
  const auth =
    p.clientAuth === "none"
      ? oidc.None()
      : p.clientAuth === "post"
        ? oidc.ClientSecretPost(secrets.clientSecret!)
        : oidc.ClientSecretBasic(secrets.clientSecret!);
  return oidc.discovery(new URL(p.issuer), p.clientId, { id_token_signed_response_alg: p.algorithm }, auth, {
    [oidc.customFetch]: fetcher,
    timeout: 15,
    execute: [
      oidc.enableNonRepudiationChecks,
      ...(p.issuer.startsWith("http:") ? [oidc.allowInsecureRequests] : []),
    ],
  });
}
export async function oidcStart(config: oidc.Configuration, callback: string, state: string, c: Correlation) {
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: callback,
    scope: "openid profile email",
    state,
    nonce: c.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(c.verifier),
    code_challenge_method: "S256",
  });
}
export async function oidcFinish(
  config: oidc.Configuration,
  url: URL,
  state: string,
  c: Correlation,
): Promise<VerifiedIdentity> {
  const result = await oidc.authorizationCodeGrant(config, url, {
    pkceCodeVerifier: c.verifier,
    expectedState: state,
    expectedNonce: c.nonce,
    idTokenExpected: true,
  });
  const claims = result.claims();
  if (!claims || typeof claims.sub !== "string" || typeof claims.exp !== "number")
    throw new Error("Missing verified OIDC claims");
  return { subject: claims.sub, claims, expiresAt: claims.exp * 1000 };
}
export function samlClient(
  p: Extract<Provider, { kind: "saml" }>,
  secrets: ProviderSecrets,
  callback: string,
  c: Correlation,
  cacheProvider: CacheProvider,
) {
  return new SAML({
    entryPoint: p.entryPoint,
    issuer: p.entityId,
    audience: p.entityId,
    callbackUrl: callback,
    idpIssuer: p.idpIssuer,
    idpCert: p.idpCert,
    privateKey: secrets.privateKey,
    publicCert: p.publicCert,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    requestIdExpirationPeriodMs: 300000,
    maxAssertionAgeMs: 300000,
    acceptedClockSkewMs: 10000,
    cacheProvider,
    generateUniqueId: () => c.requestId,
    identifierFormat: null,
  });
}
// getAssertion() contains only the assertion whose signature the library verified.
// Do not use the raw response accessor to obtain authenticated identity data.
export function samlIdentity(profile: Profile | null, callback: string, requestId: string): VerifiedIdentity {
  if (!profile?.nameID || !profile.getAssertion) throw new Error("Missing signed SAML identity");
  const parsed = profile.getAssertion() as {
    Assertion?: {
      Subject?: {
        SubjectConfirmation?: {
          $?: { Method?: string };
          SubjectConfirmationData?: {
            $?: { Recipient?: string; InResponseTo?: string; NotOnOrAfter?: string };
          }[];
        }[];
      }[];
      Conditions?: { $?: { NotOnOrAfter?: string } }[];
      AuthnStatement?: { $?: { SessionNotOnOrAfter?: string } }[];
    };
  };
  const assertion = parsed.Assertion;
  const confirmation = assertion?.Subject?.[0]?.SubjectConfirmation?.find((item) => {
    const data = item.SubjectConfirmationData?.[0]?.$;
    return (
      item.$?.Method === "urn:oasis:names:tc:SAML:2.0:cm:bearer" &&
      data?.Recipient === callback &&
      data.InResponseTo === requestId &&
      !!data.NotOnOrAfter &&
      Date.parse(data.NotOnOrAfter) > Date.now()
    );
  });
  if (!confirmation) throw new Error("SAML assertion is not bound to this callback and login");
  const limits = [
    confirmation.SubjectConfirmationData![0].$!.NotOnOrAfter,
    assertion?.Conditions?.[0]?.$?.NotOnOrAfter,
    assertion?.AuthnStatement?.[0]?.$?.SessionNotOnOrAfter,
  ]
    .filter((v): v is string => v !== undefined)
    .map(Date.parse);
  if (limits.some((v) => !Number.isFinite(v))) throw new Error("Invalid SAML expiry");
  return { subject: profile.nameID, claims: profile, expiresAt: Math.min(...limits) };
}
