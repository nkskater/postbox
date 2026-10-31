/**
 * GET /api/oauth2/callback — the provider's redirect target. Validates the state
 * against the signed-in user, exchanges the code server-side and tells the
 * opening editor window (same origin only) to collect the result.
 */
import { exchangeAuthorizationCode } from "@/core/http/auth";
import { getPolicy } from "@/server/context";
import { authorize } from "@/server/authorize";
import { currentCaller } from "@/server/access-context";
import { route } from "@/server/http";
import { getPending } from "@/server/oauth2-pending";
import { oauth2Owner } from "@/server/oauth2-owner";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, message: string, state?: string): Response {
  const notify = state
    ? `<script>try{window.opener&&window.opener.postMessage(${JSON.stringify({
        type: "postbox-oauth2",
        state,
      }).replace(
        /</g,
        "\\u003c",
      )},location.origin)}catch(e){}setTimeout(function(){window.close()},300)</script>`
    : "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui;padding:2rem"><h1 style="font-size:1.1rem">${escapeHtml(title)}</h1>` +
      `<p>${escapeHtml(message)}</p>${notify}</body>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      },
    },
  );
}

export const GET = route(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const state = params.get("state") ?? "";
  const pending = getPending(state);
  if (!pending || pending.owner !== oauth2Owner() || pending.result)
    return page(
      "Authorization failed",
      "This sign-in link is unknown, expired, already used or belongs to another session.",
    );
  const providerError = params.get("error");
  if (providerError) {
    const description = params.get("error_description");
    pending.result = {
      error: `Authorization denied: ${providerError}${description ? ` (${description})` : ""}`,
    };
    return page("Authorization denied", pending.result.error, state);
  }
  const code = params.get("code");
  if (!code) {
    pending.result = { error: "The provider did not return an authorization code" };
    return page("Authorization failed", pending.result.error, state);
  }
  try {
    // Membership may have changed since the login started.
    authorize(currentCaller(), pending.workspaceId, "run");
    const token = await exchangeAuthorizationCode(
      pending.config,
      code,
      pending.redirectUri,
      pending.verifier,
      {
        policy: getPolicy(),
        oauth2CacheScope: pending.workspaceId,
      },
    );
    pending.result = { token };
    return page("Signed in", "You can close this window and return to Postbox.", state);
  } catch (err) {
    pending.result = { error: (err as Error).message };
    return page("Authorization failed", pending.result.error, state);
  }
});
