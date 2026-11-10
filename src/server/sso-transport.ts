import type { CustomFetch } from "openid-client";
import { sendRequest } from "@/core/http/engine";
import { DEFAULT_SETTINGS } from "@/core/types";
import { getPolicy } from "./context";
/** IdP backchannel uses the same outbound host, proxy and TLS policy as request execution. */
export const ssoFetch: CustomFetch = async (url, options) => {
  const target = new URL(url);
  if (
    target.username ||
    target.password ||
    (target.protocol !== "https:" &&
      !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))
  )
    throw new Error("SSO endpoints require HTTPS outside loopback");
  const request = new Request(url, { ...options, body: options.body as BodyInit });
  const body = options.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.length > 1048576) throw new Error("SSO request is too large");
  const response = await sendRequest(
    {
      url,
      method: options.method,
      headers: Object.entries(options.headers),
      body,
      settings: { ...DEFAULT_SETTINGS, followRedirects: false, useCookieJar: false, timeoutMs: 15000 },
    },
    { policy: getPolicy(), signal: options.signal, maxBodyBytes: 1048576 },
  );
  if (response.truncated || (response.status >= 300 && response.status < 400))
    throw new Error("SSO backchannel response is oversized or redirected");
  return new Response(Buffer.from(response.bodyBase64, "base64"), {
    status: response.status,
    headers: response.headers,
  });
};
