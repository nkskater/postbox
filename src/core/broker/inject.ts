/** How the broker attaches a stored credential to a call, and keeps it out of what comes back. */
import { credentialRedactionValues } from "../retention";

export type Injection =
  | { type: "bearer" }
  | { type: "header"; name: string; prefix?: string }
  | { type: "basic"; username: string }
  | { type: "query"; name: string };

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
export const validHeaderName = (name: string) => HEADER_NAME.test(name);

/** Headers the consumer may never set: they carry credentials or identify the connection. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
]);

/** Response headers dropped before anything goes back to the consumer. */
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2", "proxy-authenticate"]);

export function consumerHeaders(
  headers: Record<string, string> | undefined,
  injection: Injection,
): [string, string][] {
  const out: [string, string][] = [];
  const injected = injection.type === "header" ? injection.name.toLowerCase() : "";
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!validHeaderName(name)) throw new Error(`Invalid header name "${name}"`);
    if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower === injected || lower.startsWith("postbox-"))
      throw new Error(`The ${name} header is set by the broker and cannot be supplied`);
    if (/[\r\n]/.test(value)) throw new Error(`Invalid value for header "${name}"`);
    out.push([name, value]);
  }
  return out;
}

/** The URL and headers with the credential attached. A same-named query parameter from the consumer is removed. */
export function attachCredential(
  url: string,
  headers: [string, string][],
  injection: Injection,
  secret: string,
): { url: string; headers: [string, string][] } {
  switch (injection.type) {
    case "bearer":
      return { url, headers: [...headers, ["Authorization", `Bearer ${secret}`]] };
    case "header":
      return { url, headers: [...headers, [injection.name, `${injection.prefix ?? ""}${secret}`]] };
    case "basic":
      return {
        url,
        headers: [
          ...headers,
          ["Authorization", `Basic ${Buffer.from(`${injection.username}:${secret}`).toString("base64")}`],
        ],
      };
    case "query": {
      const parsed = new URL(url);
      parsed.searchParams.delete(injection.name);
      parsed.searchParams.append(injection.name, secret);
      return { url: parsed.toString(), headers };
    }
  }
}

const MASK = Buffer.from("[redacted]");

/** Replace every form of the secret in a response body. Works on bytes so binary bodies are safe too. */
export function redactBytes(body: Buffer, secrets: readonly string[]): { body: Buffer; redacted: boolean } {
  let out = body;
  let redacted = false;
  const needles = credentialRedactionValues(secrets)
    .filter((s) => s.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    const bytes = Buffer.from(needle);
    if (out.indexOf(bytes) === -1) continue;
    redacted = true;
    const pieces: Buffer[] = [];
    let from = 0;
    for (let at = out.indexOf(bytes, from); at !== -1; at = out.indexOf(bytes, from)) {
      pieces.push(out.subarray(from, at), MASK);
      from = at + bytes.length;
    }
    pieces.push(out.subarray(from));
    out = Buffer.concat(pieces);
  }
  return { body: out, redacted };
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const needle of credentialRedactionValues(secrets))
    if (needle.length >= 3) out = out.split(needle).join("[redacted]");
  return out;
}

export function safeResponseHeaders(
  headers: readonly [string, string][],
  secrets: readonly string[],
): [string, string][] {
  return headers
    .filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => [name, redactText(value, secrets)]);
}
