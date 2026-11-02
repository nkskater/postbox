import { z } from "zod";
import { credentialRedactionValues } from "../retention";
import { redactStoredValue } from "../variables/resolver";
export const CAPTURE_LIMITS = { bytes: 10 * 1024 * 1024, entries: 1000, body: 1024 * 1024 };
const headers = z
  .array(z.object({ name: z.string().max(1024), value: z.string().max(16384) }))
  .max(200)
  .default([]);
const text = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= CAPTURE_LIMITS.body, "Body exceeds 1 MiB");
const entry = z.object({
  request: z.object({
    method: z.string().regex(/^[A-Z]+$/),
    url: z.string().max(16384),
    headers,
    body: text.optional(),
  }),
  response: z
    .object({
      status: z.number().int().min(100).max(599),
      statusText: z.string().max(1024).default(""),
      headers,
      body: text.optional(),
      timeMs: z.number().finite().min(0).default(0),
    })
    .optional(),
});
const capture = z.object({
  version: z.literal(1),
  entries: z.array(entry).min(1).max(CAPTURE_LIMITS.entries),
});
export type Observation = z.infer<typeof entry>;
export function readCapture(input: string): Observation[] {
  if (Buffer.byteLength(input) > CAPTURE_LIMITS.bytes) throw new Error("Capture exceeds 10 MiB");
  const value = JSON.parse(input.replace(/^\uFEFF/, ""));
  if (value?.log) {
    if (
      value.log.version !== "1.2" ||
      !Array.isArray(value.log.entries) ||
      value.log.entries.length > CAPTURE_LIMITS.entries
    )
      throw new Error("Expected HAR 1.2 with at most 1000 entries");
    const decode = (part: { text?: string; encoding?: string } | undefined) => {
      if (!part || part.text === undefined) return undefined;
      if (!part.encoding) return part.text;
      if (
        part.encoding !== "base64" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.text)
      )
        throw new Error("Unsupported capture body encoding");
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(part.text, "base64"));
    };
    return validate({
      version: 1,
      entries: value.log.entries.map((raw: Record<string, unknown>) => {
        const r = raw as {
          request: {
            method: string;
            url: string;
            headers?: unknown;
            postData?: {
              text?: string;
              encoding?: string;
              params?: { name: string; value: string; fileName?: string }[];
            };
          };
          response?: {
            status: number;
            statusText?: string;
            headers?: unknown;
            content?: { text?: string; encoding?: string };
          };
          time?: number;
        };
        if (!r.request) throw new Error("Missing HAR request");
        const post = r.request.postData;
        if (post?.params?.some((p) => p.fileName !== undefined))
          throw new Error("File uploads are unsupported; use captured text bodies");
        return {
          request: {
            ...r.request,
            body:
              decode(post) ??
              (post?.params
                ? new URLSearchParams(post.params.map((p) => [p.name, p.value])).toString()
                : undefined),
          },
          response: r.response
            ? { ...r.response, body: decode(r.response.content), timeMs: Math.max(0, r.time ?? 0) }
            : undefined,
        };
      }),
    });
  }
  return validate(value);
}
function validate(value: unknown) {
  const result = capture.parse(value);
  for (const e of result.entries) {
    const url = new URL(e.request.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) observations are supported");
  }
  return result.entries;
}
const sensitive =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|^jwt$|^signature$|^sig$|^key$|^code$/i;
/** Collect across the whole capture before emitting any reports, including echoed credentials. */
export function captureSecrets(entries: Observation[]): string[] {
  const secrets = new Set<string>();
  const remember = (value: string) => {
    if (value) secrets.add(value);
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (sensitive.test(key) && (typeof child === "string" || typeof child === "number"))
        remember(String(child));
      else walk(child);
    }
  };
  for (const e of entries) {
    const url = new URL(e.request.url);
    if (url.username) remember(decodeURIComponent(url.username));
    if (url.password) remember(decodeURIComponent(url.password));
    for (const [key, value] of url.searchParams) if (sensitive.test(key)) remember(value);
    for (const part of [e.request, e.response])
      if (part) {
        for (const h of part.headers)
          if (sensitive.test(h.name)) {
            remember(h.value);
            if (/authorization/i.test(h.name)) {
              remember(h.value.replace(/^\S+\s+/, ""));
              if (/^Basic /i.test(h.value)) {
                const decoded = Buffer.from(h.value.slice(6), "base64").toString("utf8");
                remember(decoded);
                const pos = decoded.indexOf(":");
                if (pos >= 0) remember(decoded.slice(pos + 1));
              }
            }
            if (/cookie/i.test(h.name))
              for (const item of h.value.split(";")) {
                const pos = item.indexOf("=");
                if (pos >= 0) remember(item.slice(pos + 1).trim());
              }
          }
        if (part.body) {
          try {
            walk(JSON.parse(part.body));
          } catch {
            if (
              part.headers.some((h) => /content-type/i.test(h.name) && /x-www-form-urlencoded/i.test(h.value))
            )
              for (const [key, value] of new URLSearchParams(part.body))
                if (sensitive.test(key)) remember(value);
          }
        }
      }
  }
  return [...secrets];
}
export function safeValue<T>(value: T, secrets: string[]): T {
  if (secrets.length > 10000 || secrets.reduce((size, s) => size + Buffer.byteLength(s), 0) > 1048576)
    throw new Error("Credential redaction budget exceeded");
  return redactStoredValue(value, credentialRedactionValues(secrets));
}
export function captureAsHar(entries: Observation[]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Postbox app-test", version: "1" },
      entries: entries.map((e) => ({
        time: e.response?.timeMs ?? 0,
        request: {
          method: e.request.method,
          url: e.request.url,
          headers: e.request.headers,
          postData:
            e.request.body === undefined
              ? undefined
              : {
                  mimeType:
                    e.request.headers.find((h) => /^content-type$/i.test(h.name))?.value ?? "text/plain",
                  text: e.request.body,
                },
        },
        response: e.response
          ? {
              status: e.response.status,
              statusText: e.response.statusText,
              headers: e.response.headers,
              content: {
                mimeType:
                  e.response.headers.find((h) => /^content-type$/i.test(h.name))?.value ?? "text/plain",
                text: e.response.body,
              },
            }
          : undefined,
      })),
    },
  };
}
