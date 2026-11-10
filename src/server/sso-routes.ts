import { NextResponse, type NextRequest } from "next/server";
import {
  callbackUrl,
  oidcConfiguration,
  oidcStart,
  oidcFinish,
  samlClient,
  samlIdentity,
} from "@/core/sso/protocol";
import { createState, consumeState, finishLogin, providerSecrets, samlCache, provider, hash } from "./sso";
import { ssoFetch } from "./sso-transport";
import { createUserSession, SESSION_COOKIE } from "./auth";
import { sessionSecret } from "./caller";
import { sessionTtl } from "./session-settings";
import { HttpError, readBodyText } from "./http";
import { FixedWindowLimiter } from "@/core/ratelimit";
const limiter = new FixedWindowLimiter();
const cookieName = (state: string) => `postbox_sso_${hash(state).slice(0, 20)}`;
type Context = { params: Promise<{ id: string }> };
export async function startSso(req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!limiter.hit(id, 100, 60000, Date.now()).allowed)
    throw new HttpError(429, "SSO login rate limit exceeded");
  const login = createState(id, req.nextUrl.searchParams.get("next") ?? "/"),
    p = login.provider.config;
  const callback = callbackUrl(p, id),
    secrets = providerSecrets(id);
  try {
    const destination =
      p.kind === "oidc"
        ? await oidcStart(await oidcConfiguration(p, secrets, ssoFetch), callback, login.state, login.payload)
        : await samlClient(
            p,
            secrets,
            callback,
            login.payload,
            samlCache(id, login.state),
          ).getAuthorizeUrlAsync(login.state, undefined);
    const response = NextResponse.redirect(destination, 302);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(cookieName(login.state), login.browser, {
      httpOnly: true,
      secure: p.origin.startsWith("https:"),
      sameSite: p.kind === "saml" ? "none" : "lax",
      path: "/api/auth/sso",
      maxAge: 300,
    });
    return response;
  } catch {
    throw new HttpError(400, "Unable to start SSO; check provider configuration and outbound policy");
  }
}
export async function callbackSso(req: NextRequest, context: Context) {
  const { id } = await context.params;
  const input =
    req.method === "POST" ? new URLSearchParams(await readBodyText(req, 1048576)) : req.nextUrl.searchParams;
  const state = input.get(req.method === "POST" ? "RelayState" : "state") ?? "";
  const login = consumeState(id, state, req.cookies.get(cookieName(state))?.value ?? "");
  const p = login.provider.config,
    callback = callbackUrl(p, id),
    secrets = providerSecrets(id);
  try {
    if ((p.kind === "saml") !== (req.method === "POST")) throw new Error("Wrong callback binding");
    const identity =
      p.kind === "oidc"
        ? await oidcFinish(
            await oidcConfiguration(p, secrets, ssoFetch),
            new URL(`${callback}?${input}`),
            state,
            login.payload,
          )
        : samlIdentity(
            (
              await samlClient(
                p,
                secrets,
                callback,
                login.payload,
                samlCache(id, state),
              ).validatePostResponseAsync({ SAMLResponse: input.get("SAMLResponse") ?? "" })
            ).profile,
            callback,
            login.payload.requestId,
          );
    const result = finishLogin(id, login.provider.revision, identity);
    const ttl = Math.min(sessionTtl(), result.expiresAt - Date.now());
    if (ttl <= 0) throw new Error("Identity expired");
    const session = createUserSession(sessionSecret(), result.user, ttl);
    const response = NextResponse.redirect(new URL(login.payload.next, p.origin), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(SESSION_COOKIE, session.value, {
      httpOnly: true,
      secure: p.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      expires: session.expires,
    });
    response.cookies.set(cookieName(state), "", {
      path: "/api/auth/sso",
      maxAge: 0,
      secure: p.origin.startsWith("https:"),
      sameSite: p.kind === "saml" ? "none" : "lax",
    });
    return response;
  } catch {
    throw new HttpError(400, "SSO verification failed or account access was denied; start a new login");
  }
}
export async function metadataSso(_req: Request, context: Context) {
  const { id } = await context.params,
    p = provider(id).config;
  if (p.kind !== "saml" || !p.enabled) throw new HttpError(404, "SAML provider not found");
  const client = samlClient(
    p,
    providerSecrets(id),
    callbackUrl(p, id),
    { verifier: "", nonce: "", requestId: "" },
    samlCache(id, "metadata"),
  );
  return new Response(client.generateServiceProviderMetadata(null, p.publicCert ?? null), {
    headers: { "Content-Type": "application/samlmetadata+xml", "Cache-Control": "no-store" },
  });
}
