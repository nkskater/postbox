/** HAR 1.2 recordings become editable requests without replaying captured credentials. */
import { z } from "zod";
import type { BodyConfig, FolderNode, KeyValue, RequestNode, ResponseExample } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { redactStoredValue } from "../variables/resolver";

const pair = z.object({ name: z.string(), value: z.string().default("") });
const pairs = z.array(pair).default([]);
const content = z.object({
  mimeType: z.string().default("text/plain"),
  text: z.string().optional(),
  encoding: z.string().optional(),
});
const entrySchema = z.object({
  startedDateTime: z.string().optional(),
  time: z.number().optional(),
  pageref: z.string().optional(),
  request: z.object({
    method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    url: z.string(),
    headers: pairs,
    queryString: pairs,
    cookies: pairs,
    postData: z
      .object({
        mimeType: z.string(),
        text: z.string().optional(),
        encoding: z.string().optional(),
        params: z
          .array(pair.extend({ fileName: z.string().optional(), contentType: z.string().optional() }))
          .optional(),
      })
      .optional(),
  }),
  response: z
    .object({
      status: z.number().int().min(0).max(599),
      statusText: z.string().default(""),
      headers: pairs,
      cookies: pairs,
      content: content.optional(),
    })
    .optional(),
});
const archiveSchema = z.object({
  log: z.object({
    version: z.literal("1.2"),
    creator: z.object({ name: z.string(), version: z.string() }).optional(),
    entries: z.array(z.unknown()).max(10000),
  }),
});
const sensitive = (key: string) =>
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|^jwt$|^signature$|^sig$|^key$|^code$/i.test(
    key,
  );
const MASK = "[REDACTED]";
const BODY_LIMIT = 1024 * 1024;
const textual = (mime: string) => /^(text\/)|json|xml|javascript|x-www-form-urlencoded|graphql/i.test(mime);

export function isHar(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "log" in value &&
    !!value.log &&
    typeof value.log === "object" &&
    "entries" in value.log
  );
}

export function importHar(
  value: unknown,
  options: { now?: () => number } = {},
): { root: FolderNode; variables: []; warnings: string[] } {
  const parsed = archiveSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Expected a HAR 1.2 log with an entries array (maximum 10000 entries).");
  const archive = parsed.data;
  const warnings: string[] = [];
  let warningCount = 0;
  const warn = (index: number, message: string) => {
    warningCount++;
    if (warnings.length < 200) warnings.push(`Entry ${index + 1}: ${message}`);
  };
  const secrets = new Set<string>();
  const remember = (value: string) => {
    if (value && value !== MASK) secrets.add(value);
  };
  const cleanPairs = (values: z.infer<typeof pairs>, cookies = false): KeyValue[] =>
    values.map(({ name, value }) => {
      const hidden = cookies || sensitive(name);
      if (hidden) {
        remember(value);
        if (/^(proxy-)?authorization$/i.test(name)) {
          remember(value.replace(/^\S+\s+/, ""));
          if (/^Basic\s+/i.test(value)) {
            const decoded = Buffer.from(value.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
            remember(decoded);
            const separator = decoded.indexOf(":");
            if (separator >= 0) {
              remember(decoded.slice(0, separator));
              remember(decoded.slice(separator + 1));
            }
          }
        }
        if (/^(set-)?cookie$/i.test(name)) {
          const values = /^set-cookie$/i.test(name) ? [value.split(";")[0]] : value.split(";");
          for (const cookie of values) {
            const separator = cookie.indexOf("=");
            if (separator >= 0) remember(cookie.slice(separator + 1).trim());
          }
        }
      }
      return { key: name, value: hidden ? MASK : value, enabled: !hidden };
    });
  const cleanUrl = (raw: string) => {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported URL protocol");
    if (url.username) remember(decodeURIComponent(url.username));
    if (url.password) remember(decodeURIComponent(url.password));
    url.username = "";
    url.password = "";
    for (const [name, value] of url.searchParams) if (sensitive(name)) remember(value);
    const entries = [...url.searchParams].map(
      ([name, value]) => [name, sensitive(name) ? MASK : value] as const,
    );
    url.search = "";
    for (const [name, value] of entries) url.searchParams.append(name, value);
    return url;
  };
  const cleanText = (text: string, mime: string): string => {
    if (text === "") return text;
    if (/json/i.test(mime)) {
      try {
        const clean = (value: unknown, depth = 0): unknown => {
          if (depth > 100) throw new Error("Too deeply nested");
          if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([key, value]) => {
                if (sensitive(key)) {
                  if (typeof value === "string" || typeof value === "number") remember(String(value));
                  return [key, MASK];
                }
                return [key, clean(value, depth + 1)];
              }),
            );
          return value;
        };
        return JSON.stringify(clean(JSON.parse(text)), null, 2);
      } catch {
        throw new Error("Malformed JSON body");
      }
    }
    if (/x-www-form-urlencoded/i.test(mime)) {
      const result = new URLSearchParams();
      for (const [key, value] of new URLSearchParams(text)) {
        if (sensitive(key)) remember(value);
        result.append(key, sensitive(key) ? MASK : value);
      }
      return result.toString();
    }
    return text;
  };
  const decodeText = (data: z.infer<typeof content>) => {
    if (data.text === undefined) return undefined;
    if (Buffer.byteLength(data.text, "utf8") > BODY_LIMIT)
      throw new Error("Body exceeds the 1 MB import limit");
    if (data.encoding && data.encoding !== "base64") throw new Error("Unsupported body encoding");
    const charset = /charset=["\']?([^;"\'\s]+)/i.exec(data.mimeType)?.[1];
    if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) throw new Error("Unsupported body charset");
    if (!textual(data.mimeType)) throw new Error("Binary body cannot be represented as a text example");
    let text = data.text;
    if (data.encoding === "base64") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
        throw new Error("Invalid base64 body");
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "base64"));
    }
    return cleanText(text, data.mimeType);
  };
  const children: RequestNode[] = [];
  for (const [index, raw] of archive.log.entries.entries()) {
    const parsedEntry = entrySchema.safeParse(raw);
    if (!parsedEntry.success) {
      warn(index, "Skipped malformed entry.");
      continue;
    }
    const entry = parsedEntry.data;
    const before = secrets.size;
    let url: URL;
    try {
      url = cleanUrl(entry.request.url);
    } catch {
      warn(index, "Skipped unsupported or invalid request URL.");
      continue;
    }
    const headers = cleanPairs(entry.request.headers);
    const cookies = cleanPairs(entry.request.cookies, true);
    if (cookies.length && !headers.some((h) => h.key.toLowerCase() === "cookie"))
      headers.push({
        key: "Cookie",
        value: cookies.map((c) => `${c.key}=${c.value}`).join("; "),
        enabled: false,
      });
    // The URL is authoritative when queryString and url disagree; never duplicate its query.
    const params = cleanPairs(entry.request.queryString);
    if (!url.search && params.length)
      for (const param of params) url.searchParams.append(param.key, param.value);
    else if (
      params.length &&
      new URLSearchParams(entry.request.url.split("?")[1]?.split("#")[0] ?? "").toString() !==
        new URLSearchParams(entry.request.queryString.map(({ name, value }) => [name, value])).toString()
    )
      warn(index, "Query metadata differs from URL; retained the URL query.");
    let body: BodyConfig = { mode: "none" };
    const post = entry.request.postData;
    try {
      if (post) {
        if (
          entry.request.headers.some(
            (h) => /^content-encoding$/i.test(h.name) && !/^identity$/i.test(h.value),
          )
        )
          throw new Error("Unsupported request content encoding");
        if (post.encoding && post.encoding !== "base64") throw new Error("Unsupported request body encoding");
        if (post.params?.some((param) => param.fileName !== undefined))
          throw new Error("File upload bytes were not captured");
        if (
          post.params &&
          (post.params.length > 0 || post.text === undefined) &&
          /x-www-form-urlencoded/i.test(post.mimeType)
        )
          body = { mode: "urlencoded", urlencoded: cleanPairs(post.params) };
        else if (
          post.params &&
          (post.params.length > 0 || post.text === undefined) &&
          /multipart\/form-data/i.test(post.mimeType)
        )
          body = { mode: "formdata", formdata: cleanPairs(post.params).map((p) => ({ ...p, type: "text" })) };
        else if (post.text !== undefined) {
          const text = decodeText({ ...post, mimeType: post.mimeType });
          body = {
            mode: "raw",
            raw: text ?? "",
            language: /json/i.test(post.mimeType) ? "json" : /xml/i.test(post.mimeType) ? "xml" : "text",
          };
        } else if (post.params?.length) throw new Error("Unsupported request parameter encoding");
      }
    } catch (error) {
      const reason = error instanceof TypeError ? "Invalid UTF-8 body text" : (error as Error).message;
      warn(index, `Skipped request: ${reason}.`);
      continue;
    }
    if (post && body.mode !== "formdata" && !headers.some((header) => /^content-type$/i.test(header.key)))
      headers.push({ key: "Content-Type", value: post.mimeType, enabled: true });
    for (const header of headers)
      if (
        /^(host|content-length|transfer-encoding|connection|accept-encoding)$/i.test(header.key) ||
        (body.mode === "formdata" && /^content-type$/i.test(header.key))
      )
        header.enabled = false;
    const examples: ResponseExample[] = [];
    if (entry.response) {
      const response = entry.response;
      const responseHeaders = cleanPairs(response.headers);
      const responseCookies = cleanPairs(response.cookies, true);
      if (responseCookies.length && !responseHeaders.some((h) => h.key.toLowerCase() === "set-cookie"))
        responseHeaders.push(
          ...responseCookies.map((c) => ({
            key: "Set-Cookie",
            value: `${c.key}=${c.value}`,
            enabled: false,
          })),
        );
      let body = "",
        unavailable = false;
      try {
        const decoded = response.content ? decodeText(response.content) : undefined;
        body = decoded ?? "";
        unavailable = decoded === undefined;
      } catch {
        unavailable = true;
      }
      if (unavailable)
        warn(
          index,
          "Response body unavailable: missing, unsupported encoding, binary, invalid text, or over 1 MB.",
        );
      examples.push({
        id: `har-example-${index}`,
        name: unavailable ? "Captured response (body unavailable)" : "Captured response",
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body,
        createdAt: Number.isFinite(Date.parse(entry.startedDateTime ?? ""))
          ? Date.parse(entry.startedDateTime!)
          : (options.now?.() ?? Date.now()),
      });
    }
    if (secrets.size > before || cookies.length || headers.some((h) => h.value === MASK))
      warn(index, "Credentials redacted; configure authentication before replay.");
    const query = [...url.searchParams].map(([key, value]) => ({ key, value, enabled: !sensitive(key) }));
    url.search = new URLSearchParams(query.filter((p) => p.enabled).map((p) => [p.key, p.value])).toString();
    url.hash = "";
    children.push({
      kind: "request",
      id: `har-request-${index}`,
      name: `${index + 1}. ${entry.request.method} ${url.pathname}`,
      method: entry.request.method,
      url: url.toString(),
      params: query,
      headers,
      body,
      auth: { type: "none" },
      settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
      preRequestScript: "",
      testScript: "",
      examples,
      description: `HAR entry ${index + 1}\nStarted: ${entry.startedDateTime ?? "unknown"}\nDuration (ms): ${entry.time ?? "unknown"}\nPage reference: ${entry.pageref ?? "none"}`,
    });
  }
  if (!children.length) throw new Error("HAR contains no importable HTTP requests.");
  if (warningCount > warnings.length)
    warnings.push(`${warningCount - warnings.length} additional diagnostics omitted.`);
  const root: FolderNode = {
    kind: "folder",
    id: "har-root",
    name: "HAR recording",
    auth: { type: "none" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    description: `HAR ${archive.log.version}\nCreator: ${archive.log.creator?.name ?? "unknown"} ${archive.log.creator?.version ?? ""}`,
    children,
  };
  // Redact values learned anywhere in the archive from echoed and encoded payloads too.
  const derivedSecrets = [...secrets].flatMap((secret) => [secret, Buffer.from(secret).toString("base64")]);
  if (derivedSecrets.reduce((size, secret) => size + secret.length, 0) > 100_000)
    throw new Error("HAR has too much credential data to sanitize safely.");
  const safe = redactStoredValue(
    {
      description: root.description,
      requests: children.map((request) => ({
        name: request.name,
        url: request.url,
        description: request.description,
        params: request.params,
        headers: request.headers,
        raw: request.body.mode === "raw" ? request.body.raw : undefined,
        fields:
          request.body.mode === "urlencoded"
            ? request.body.urlencoded
            : request.body.mode === "formdata"
              ? request.body.formdata.map(({ key, value, enabled }) => ({ key, value, enabled }))
              : undefined,
        examples: request.examples,
      })),
    },
    derivedSecrets,
  );
  return {
    root: {
      ...root,
      description: safe.description,
      children: children.map((request, index) => {
        const data = safe.requests[index];
        let body = request.body;
        if (body.mode === "raw") body = { ...body, raw: data.raw ?? "" };
        if (body.mode === "urlencoded") body = { ...body, urlencoded: data.fields ?? [] };
        if (body.mode === "formdata")
          body = { ...body, formdata: body.formdata.map((field, i) => ({ ...field, ...data.fields?.[i] })) };
        return {
          ...request,
          name: data.name,
          url: data.url,
          description: data.description,
          params: data.params,
          headers: data.headers,
          body,
          examples: data.examples?.map((example, i) => ({
            ...example,
            id: request.examples![i].id,
            name: request.examples![i].name,
          })),
        };
      }),
    },
    variables: [],
    warnings,
  };
}
