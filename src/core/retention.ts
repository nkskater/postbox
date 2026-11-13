import type { AuthConfig, BodyConfig, ResponseExample, KeyValue } from "./types";
import { redactStoredValue } from "./variables/resolver";

/** Uploaded request files are limited to 5 MiB of decoded bytes per request. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
export const base64ByteLength = (value: string) =>
  Math.max(0, Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0));
export const SENSITIVE_NAME =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|^jwt$|^signature$|^sig$|^code$/i;

const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

/**
 * Stands in for a value that was deliberately not written to browser storage. A restored tab shows it
 * where the value was, the editor explains it, and sending or saving refuses while it is present.
 */
export const WITHHELD = "\u27e6withheld\u27e7";

/** Whether a request (examples aside) still holds a value withheld from browser storage. */
export function containsWithheld(value: unknown): boolean {
  if (typeof value === "string") return value.includes(WITHHELD);
  if (Array.isArray(value)) return value.some(containsWithheld);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => key !== "examples" && containsWithheld(entry));
}

/**
 * Put back values withheld from browser storage using the server copy of the same request. A withheld
 * string is replaced only where the server value, sanitized the same way, gives exactly the stored text,
 * so an edited field is never overwritten with an older value.
 */
export function restoreWithheldValues<T extends { auth: AuthConfig; body: BodyConfig }>(
  current: T,
  saved: T,
): T {
  const masked = sanitizeRequestDraftForBrowser(saved);
  const walk = (value: unknown, maskedValue: unknown, savedValue: unknown): unknown => {
    if (typeof value === "string")
      return value.includes(WITHHELD) && value === maskedValue && typeof savedValue === "string"
        ? savedValue
        : value;
    if (Array.isArray(value))
      return Array.isArray(maskedValue) && Array.isArray(savedValue)
        ? value.map((entry, index) => walk(entry, maskedValue[index], savedValue[index]))
        : value;
    if (!value || typeof value !== "object" || !maskedValue || typeof maskedValue !== "object") return value;
    if (!savedValue || typeof savedValue !== "object") return value;
    const m = maskedValue as Record<string, unknown>,
      s = savedValue as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "examples" ? entry : walk(entry, m[key], s[key]),
      ]),
    );
  };
  return walk(current, masked, saved) as T;
}

/** Earlier versions stored these placeholders in place of withheld values. */
export function withLegacyPlaceholdersMarked<T>(value: T): T {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string")
      return input.replaceAll("[REDACTED]", WITHHELD).replaceAll("********", WITHHELD);
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [key, key === "examples" ? entry : walk(entry)]),
    );
  };
  return walk(value) as T;
}

/**
 * A value made only of {{variable}} / {{vault:name}} references (optionally after an auth scheme word) holds
 * no secret itself, so it is kept as written. Redacting it would turn a reference into the literal text
 * "[REDACTED]" that is later sent to the server.
 */
export function isReferenceOnly(value: string): boolean {
  // Text pasted from documents or chat often carries zero-width characters around the reference.
  const visible = value.replace(INVISIBLE, "");
  const rest = visible.replace(/\{\{\s*[^{}]+\s*\}\}/g, "");
  if (rest === visible) return false;
  return /^\s*(?:(?:bearer|basic|token|digest)\s+)?[\s,&;:=]*$/i.test(rest);
}

/** Values that should not be copied into browser storage or default exports. */
export function authCredentialValues(auth: AuthConfig): string[] {
  const values = (() => {
    switch (auth.type) {
      case "bearer":
        return [auth.bearer.token];
      case "basic":
      case "digest":
        return [auth.type === "basic" ? auth.basic.password : auth.digest.password];
      case "ntlm":
        return [auth.ntlm.password];
      case "apikey":
        return [auth.apikey.value];
      case "oauth2":
        return [
          auth.oauth2.clientSecret,
          auth.oauth2.password ?? "",
          auth.oauth2.accessToken,
          auth.oauth2.refreshToken ?? "",
        ];
      case "edgegrid":
        return [auth.edgegrid.clientSecret, auth.edgegrid.accessToken, auth.edgegrid.clientToken];
      case "hawk":
        return [auth.hawk.authKey];
      case "awsv4":
        return [auth.awsv4.secretKey, auth.awsv4.sessionToken ?? ""];
      case "asap":
        return [auth.asap.privateKey];
      case "oauth1":
        return [auth.oauth1.consumerSecret, auth.oauth1.tokenSecret ?? "", auth.oauth1.privateKey ?? ""];
      default:
        return [];
    }
  })();
  return values.filter((value) => value && !/^\{\{\s*[^{}]+\s*\}\}$/.test(value));
}

export function credentialRedactionValues(values: Iterable<string>): string[] {
  const expanded = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    expanded.add(value);
    try {
      const encoded = encodeURIComponent(value);
      expanded.add(encoded);
      expanded.add(encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
      expanded.add(encoded.replace(/%20/g, "+"));
      expanded.add(JSON.stringify(value).slice(1, -1));
    } catch {
      // Keep the literal secret when a derived encoding cannot be produced.
    }
    if (value.length <= 100_000) {
      const bytes = new TextEncoder().encode(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      try {
        expanded.add(btoa(binary));
      } catch {
        // Base64 is an optional variant; literal and URI forms are still redacted.
      }
    }
  }
  return [...expanded];
}

export function withoutAuthCredentials(auth: AuthConfig): AuthConfig {
  switch (auth.type) {
    case "bearer":
      return { ...auth, bearer: { ...auth.bearer, token: "" } };
    case "basic":
      return { ...auth, basic: { ...auth.basic, password: "" } };
    case "digest":
      return { ...auth, digest: { ...auth.digest, password: "" } };
    case "ntlm":
      return { ...auth, ntlm: { ...auth.ntlm, password: "" } };
    case "apikey":
      return { ...auth, apikey: { ...auth.apikey, value: "" } };
    case "oauth2": {
      const { oauth2 } = auth;
      return {
        ...auth,
        oauth2: {
          ...oauth2,
          clientSecret: "",
          password: oauth2.password === undefined ? undefined : "",
          accessToken: "",
          refreshToken: undefined,
          expiresAt: undefined,
          tokenContext: undefined,
        },
      };
    }
    case "edgegrid":
      return { ...auth, edgegrid: { ...auth.edgegrid, clientSecret: "", accessToken: "", clientToken: "" } };
    case "hawk":
      return { ...auth, hawk: { ...auth.hawk, authKey: "" } };
    case "asap":
      return { ...auth, asap: { ...auth.asap, privateKey: "" } };
    case "oauth1":
      return {
        ...auth,
        oauth1: {
          ...auth.oauth1,
          consumerSecret: "",
          tokenSecret: auth.oauth1.tokenSecret === undefined ? undefined : "",
          privateKey: auth.oauth1.privateKey === undefined ? undefined : "",
        },
      };
    case "awsv4":
      return {
        ...auth,
        awsv4: {
          ...auth.awsv4,
          secretKey: "",
          sessionToken: auth.awsv4.sessionToken === undefined ? undefined : "",
        },
      };
    default:
      return auth;
  }
}

/** Keep protocol discriminants valid when a short secret happens to match their text. */
export function retainedRequestStructure<
  T extends {
    auth: AuthConfig;
    body: BodyConfig;
    method?: string;
    headers?: KeyValue[];
    params?: KeyValue[];
  },
>(original: T, redacted: T): T {
  const auth = { ...redacted.auth, type: original.auth.type } as AuthConfig;
  const enumFields: Partial<Record<AuthConfig["type"], string[]>> = {
    apikey: ["in"],
    oauth2: ["grantType", "clientAuthentication", "codeChallengeMethod"],
    oauth1: ["signatureMethod", "addTo"],
    awsv4: ["addTo"],
    hawk: ["algorithm"],
    asap: ["algorithm"],
  };
  const source = (original.auth as unknown as Record<string, unknown>)[original.auth.type];
  if (source && typeof source === "object") {
    const key = original.auth.type,
      record = auth as unknown as Record<string, unknown>;
    const target = { ...(record[key] as Record<string, unknown>) };
    for (const field of enumFields[key] ?? [])
      if (Object.hasOwn(source, field)) target[field] = (source as Record<string, unknown>)[field];
    record[key] = target;
  }
  let body = { ...redacted.body, mode: original.body.mode } as BodyConfig;
  if (original.body.mode === "raw" && body.mode === "raw")
    body = { ...body, language: original.body.language };
  if (original.body.mode === "formdata" && body.mode === "formdata") {
    const fields = original.body.formdata;
    body = {
      ...body,
      formdata: body.formdata.map((field, index) => ({
        ...field,
        type: fields[index].type,
        key: fields[index].key,
      })),
    };
  }
  return {
    ...redacted,
    auth: withoutAuthCredentials(auth),
    body,
    ...(original.method !== undefined ? { method: original.method } : {}),
    ...(original.headers && redacted.headers
      ? { headers: redacted.headers.map((field, index) => ({ ...field, key: original.headers![index].key })) }
      : {}),
    ...(original.params && redacted.params
      ? { params: redacted.params.map((field, index) => ({ ...field, key: original.params![index].key })) }
      : {}),
  };
}

export function restoreMissingCredentials(current: AuthConfig, saved: AuthConfig): AuthConfig {
  if (current.type !== saved.type) return current;
  switch (current.type) {
    case "bearer":
      return {
        ...current,
        bearer: { ...current.bearer, token: current.bearer.token || (saved as typeof current).bearer.token },
      };
    case "basic":
      return {
        ...current,
        basic: {
          ...current.basic,
          password: current.basic.password || (saved as typeof current).basic.password,
        },
      };
    case "digest":
      return {
        ...current,
        digest: {
          ...current.digest,
          password: current.digest.password || (saved as typeof current).digest.password,
        },
      };
    case "ntlm":
      return {
        ...current,
        ntlm: { ...current.ntlm, password: current.ntlm.password || (saved as typeof current).ntlm.password },
      };
    case "apikey":
      return {
        ...current,
        apikey: { ...current.apikey, value: current.apikey.value || (saved as typeof current).apikey.value },
      };
    case "oauth2": {
      const previous = (saved as typeof current).oauth2;
      return {
        ...current,
        oauth2: {
          ...current.oauth2,
          clientSecret: current.oauth2.clientSecret || previous.clientSecret,
          password: current.oauth2.password || previous.password,
          accessToken: current.oauth2.accessToken || previous.accessToken,
          refreshToken: current.oauth2.refreshToken || previous.refreshToken,
          expiresAt: current.oauth2.expiresAt ?? previous.expiresAt,
          tokenContext: current.oauth2.tokenContext ?? previous.tokenContext,
        },
      };
    }
    case "edgegrid": {
      const previous = (saved as typeof current).edgegrid;
      return {
        ...current,
        edgegrid: {
          ...current.edgegrid,
          clientSecret: current.edgegrid.clientSecret || previous.clientSecret,
          accessToken: current.edgegrid.accessToken || previous.accessToken,
          clientToken: current.edgegrid.clientToken || previous.clientToken,
        },
      };
    }
    case "hawk":
      return {
        ...current,
        hawk: { ...current.hawk, authKey: current.hawk.authKey || (saved as typeof current).hawk.authKey },
      };
    case "asap":
      return {
        ...current,
        asap: {
          ...current.asap,
          privateKey: current.asap.privateKey || (saved as typeof current).asap.privateKey,
        },
      };
    case "oauth1": {
      const previous = (saved as typeof current).oauth1;
      return {
        ...current,
        oauth1: {
          ...current.oauth1,
          consumerSecret: current.oauth1.consumerSecret || previous.consumerSecret,
          tokenSecret: current.oauth1.tokenSecret || previous.tokenSecret,
          privateKey: current.oauth1.privateKey || previous.privateKey,
        },
      };
    }
    case "awsv4": {
      const previous = (saved as typeof current).awsv4;
      return {
        ...current,
        awsv4: {
          ...current.awsv4,
          secretKey: current.awsv4.secretKey || previous.secretKey,
          sessionToken: current.awsv4.sessionToken || previous.sessionToken,
        },
      };
    }
    default:
      return current;
  }
}

/** Remove file bytes from locally restored drafts while retaining reselectable rows. */
export function withoutUploadBytes(body: BodyConfig): BodyConfig {
  if (body.mode === "binary" && body.binary)
    return { ...body, binary: { ...body.binary, data: "", missing: true } };
  if (body.mode === "formdata")
    return {
      ...body,
      formdata: body.formdata.map((field) =>
        field.type === "file" ? { ...field, data: undefined, missing: true } : field,
      ),
    };
  return body;
}

export function hasMissingUpload(body: BodyConfig): boolean {
  return body.mode === "binary"
    ? !!body.binary?.missing
    : body.mode === "formdata"
      ? body.formdata.some((field) => field.type === "file" && field.missing)
      : false;
}

export function restoreMissingUploadBytes(current: BodyConfig, saved: BodyConfig): BodyConfig {
  if (current.mode === "binary" && current.binary?.missing && saved.mode === "binary" && saved.binary) {
    if (current.binary.fileName === saved.binary.fileName)
      return {
        ...current,
        binary: { ...saved.binary, ...current.binary, data: saved.binary.data, missing: false },
      };
  }
  if (current.mode === "formdata" && saved.mode === "formdata") {
    return {
      ...current,
      formdata: current.formdata.map((field, index) => {
        const previous = saved.formdata[index];
        if (
          field.type === "file" &&
          field.missing &&
          previous?.type === "file" &&
          previous.key === field.key &&
          previous.fileName === field.fileName
        )
          return { ...field, data: previous.data, missing: false };
        return field;
      }),
    };
  }
  return current;
}

export function redactSensitiveFields<T>(value: T, placeholder = "[REDACTED]"): T {
  if (typeof value === "string") {
    return value
      .replace(
        /([?&][^=&]*(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|jwt|signature|sig|code)[^=&]*=)([^&#]*)/gi,
        (_all, head: string, val: string) => (isReferenceOnly(val) ? _all : `${head}${placeholder}`),
      )
      .replace(
        /(["'][^"']*(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|jwt|signature|sig|code)[^"']*["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]+)/gi,
        (_all, head: string, val: string) =>
          isReferenceOnly(val.replace(/^["']|["']$/g, "")) ? _all : `${head}"${placeholder}"`,
      ) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveFields(entry, placeholder)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record.key === "string" &&
    SENSITIVE_NAME.test(record.key) &&
    typeof record.value === "string" &&
    !isReferenceOnly(record.value)
  ) {
    return { ...record, value: placeholder } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      SENSITIVE_NAME.test(key) && typeof entry === "string" && !isReferenceOnly(entry)
        ? placeholder
        : redactSensitiveFields(entry, placeholder),
    ]),
  ) as T;
}

export function sensitiveFieldValues(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" ? sensitiveFieldValues(parsed) : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(sensitiveFieldValues);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const values: string[] = [];
  if (
    typeof record.key === "string" &&
    SENSITIVE_NAME.test(record.key) &&
    typeof record.value === "string" &&
    !isReferenceOnly(record.value)
  )
    values.push(record.value);
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_NAME.test(key) && typeof entry === "string") {
      if (!isReferenceOnly(entry)) values.push(entry);
    } else if (entry !== record.value || key !== "value") values.push(...sensitiveFieldValues(entry));
  }
  return values;
}

/**
 * The copy of a request draft written to browser storage. Credentials and upload bytes are dropped, and
 * other literal secrets become {@link WITHHELD}; variable references are kept exactly as written. Saved
 * examples keep the export placeholders, since they are display data and never sent.
 */
export function sanitizeRequestDraftForBrowser<T extends { auth: AuthConfig; body: BodyConfig }>(
  draft: T,
): T {
  const examples = (draft as T & { examples?: ResponseExample[] }).examples;
  const exampleSecrets = (examples ?? []).flatMap((example) => [
    ...sensitiveFieldValues(example),
    ...(example.originalRequest ? authCredentialValues(example.originalRequest.auth) : []),
  ]);
  const secrets = credentialRedactionValues([...authCredentialValues(draft.auth), ...exampleSecrets]);
  const { examples: _examples, ...request } = draft as T & { examples?: ResponseExample[] };
  const safeRequest = redactSensitiveFields({ ...request, body: withoutUploadBytes(draft.body) }, WITHHELD);
  const result = redactStoredValue({ ...safeRequest, auth: withoutAuthCredentials(draft.auth) }, secrets, {
    mask: WITHHELD,
    keepReferences: true,
  }) as unknown as T;
  if (examples) {
    const safeExamples = redactStoredValue(
      redactSensitiveFields(
        examples.map((example) => ({
          ...example,
          ...(example.originalRequest
            ? { originalRequest: sanitizeExampleRequest(example.originalRequest) }
            : {}),
        })),
      ),
      secrets,
    );
    (result as T & { examples: ResponseExample[] }).examples = safeExamples.map((example, index) => ({
      ...example,
      ...(example.originalRequest
        ? {
            originalRequest: retainedRequestStructure(
              examples[index].originalRequest!,
              example.originalRequest,
            ),
          }
        : {}),
    }));
  }
  return retainedRequestStructure(draft, result);
}

/** An example's request as stored with the example: export placeholders, no credentials or upload bytes. */
function sanitizeExampleRequest<T extends { auth: AuthConfig; body: BodyConfig }>(request: T): T {
  const secrets = credentialRedactionValues(authCredentialValues(request.auth));
  const safe = redactSensitiveFields({ ...request, body: withoutUploadBytes(request.body) });
  return retainedRequestStructure(
    request,
    redactStoredValue({ ...safe, auth: withoutAuthCredentials(request.auth) }, secrets),
  );
}
