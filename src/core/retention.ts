import type { AuthConfig, BodyConfig } from "./types";
import { redactStoredValue } from "./variables/resolver";

/** Uploaded request files are limited to 5 MiB of decoded bytes per request. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
export const base64ByteLength = (value: string) =>
  Math.max(0, Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0));
const SENSITIVE_NAME =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|^jwt$|^signature$|^sig$|^code$/i;

/** Values that should not be copied into browser storage or default exports. */
export function authCredentialValues(auth: AuthConfig): string[] {
  const values = (() => {
    switch (auth.type) {
      case "bearer":
        return [auth.bearer.token];
      case "basic":
      case "digest":
        return [auth.type === "basic" ? auth.basic.password : auth.digest.password];
      case "apikey":
        return [auth.apikey.value];
      case "oauth2":
        return [auth.oauth2.clientSecret, auth.oauth2.password ?? "", auth.oauth2.accessToken];
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

export function redactSensitiveFields<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(
        /([?&][^=&]*(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|jwt|signature|sig|code)[^=&]*=)[^&#]*/gi,
        "$1[REDACTED]",
      )
      .replace(
        /(["'][^"']*(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|jwt|signature|sig|code)[^"']*["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]+)/gi,
        '$1"[REDACTED]"',
      ) as T;
  }
  if (Array.isArray(value)) return value.map(redactSensitiveFields) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.key === "string" && SENSITIVE_NAME.test(record.key) && typeof record.value === "string") {
    return { ...record, value: "[REDACTED]" } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      SENSITIVE_NAME.test(key) && typeof entry === "string" ? "[REDACTED]" : redactSensitiveFields(entry),
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
  if (typeof record.key === "string" && SENSITIVE_NAME.test(record.key) && typeof record.value === "string")
    values.push(record.value);
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_NAME.test(key) && typeof entry === "string") values.push(entry);
    else if (entry !== record.value || key !== "value") values.push(...sensitiveFieldValues(entry));
  }
  return values;
}

export function sanitizeRequestDraftForBrowser<T extends { auth: AuthConfig; body: BodyConfig }>(
  draft: T,
): T {
  const secrets = credentialRedactionValues(authCredentialValues(draft.auth));
  const safe = redactSensitiveFields({
    ...draft,
    body: withoutUploadBytes(draft.body),
  });
  return redactStoredValue({ ...safe, auth: withoutAuthCredentials(draft.auth) }, secrets);
}
