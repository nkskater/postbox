/** Saved request/response pairs and the retention contract shared by UI, converters and persistence. */
import type { ExampleRequest, RequestDef, ResponseExample } from "./types";
import { responseExampleSchema } from "./schemas";
import {
  authCredentialValues,
  credentialRedactionValues,
  MAX_UPLOAD_BYTES,
  redactSensitiveFields,
  sensitiveFieldValues,
  withoutAuthCredentials,
  retainedRequestStructure,
  withoutUploadBytes,
  base64ByteLength,
} from "./retention";
import { redactStoredValue } from "./variables/resolver";
export const MAX_EXAMPLES = 100;
/** Draft identifiers also work on self-hosted HTTP origins without randomUUID. */
export const exampleDraftId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `example-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const secretName =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|jwt|signature|^sig$|^code$/i;
export function exampleRequest(request: ExampleRequest): ExampleRequest {
  return {
    method: request.method,
    url: request.url,
    params: request.params,
    headers: request.headers,
    body: request.body,
    auth: request.auth,
    ...(request.description ? { description: request.description } : {}),
  };
}
function urlSecrets(raw: string): string[] {
  try {
    const url = new URL(raw, "http://postbox.invalid");
    return [
      url.username,
      url.password,
      ...[...url.searchParams].flatMap(([key, value]) => (secretName.test(key) ? [value] : [])),
    ]
      .filter(Boolean)
      .flatMap((value) => {
        try {
          return [value, decodeURIComponent(value)];
        } catch {
          return [value];
        }
      });
  } catch {
    return [];
  }
}
export function sanitizeExample(
  input: ResponseExample,
  inheritedSecrets: Iterable<string> = [],
): ResponseExample {
  const request = input.originalRequest;
  let decodedBinary = "";
  if (input.bodyEncoding === "base64") {
    try {
      decodedBinary = new TextDecoder().decode(Uint8Array.from(atob(input.body), (ch) => ch.charCodeAt(0)));
    } catch {
      /* Validation reports malformed base64 before persistence. */
    }
  }
  const secrets = credentialRedactionValues([
    ...inheritedSecrets,
    ...sensitiveFieldValues(input),
    ...sensitiveFieldValues(decodedBinary),
    ...(request ? [...authCredentialValues(request.auth), ...urlSecrets(request.url)] : []),
  ]);
  const safe = redactStoredValue(
    redactSensitiveFields({
      ...input,
      ...(request
        ? {
            originalRequest: {
              ...exampleRequest(request),
              auth: withoutAuthCredentials(request.auth),
              body: withoutUploadBytes(request.body),
              url: request.url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[REDACTED]@"),
            },
          }
        : {}),
    }),
    secrets,
  );
  // Identifiers are references; short secrets may overlap their characters.
  const binaryOmitted =
    input.bodyEncoding === "base64" &&
    (safe.body !== input.body ||
      redactSensitiveFields(decodedBinary) !== decodedBinary ||
      secrets.some((secret) => decodedBinary.includes(secret)));
  return {
    ...safe,
    headers: safe.headers.map((header, index) => ({ ...header, key: input.headers[index].key })),
    ...(request && safe.originalRequest
      ? { originalRequest: retainedRequestStructure(request, safe.originalRequest) }
      : {}),
    ...(binaryOmitted ? { body: "", bodyOmitted: true } : {}),
    id: input.id,
    createdAt: input.createdAt,
  };
}
export function validateExamples(input: ResponseExample[]): ResponseExample[] {
  if (input.length > MAX_EXAMPLES) throw new Error(`A request supports at most ${MAX_EXAMPLES} examples`);
  const ids = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  return input.map((raw) => {
    const example = responseExampleSchema.parse(raw);
    if (ids.has(example.id)) throw new Error("Example IDs must be unique within a request");
    ids.add(example.id);
    const bodyBytes =
      example.bodyEncoding === "base64"
        ? base64ByteLength(example.body)
        : encoder.encode(example.body).byteLength;
    if (
      example.bodyEncoding === "base64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(example.body)
    )
      throw new Error("Example body must be valid base64");
    if (bodyBytes > MAX_UPLOAD_BYTES) throw new Error("Example response body exceeds 5 MiB");
    bytes += encoder.encode(JSON.stringify(example)).byteLength;
    if (bytes > 20 * 1024 * 1024) throw new Error("Saved example content exceeds 20 MiB per request");
    return example;
  });
}
export function exampleFromResponse(
  request: ExampleRequest,
  response: {
    status: number;
    statusText: string;
    headers: [string, string][];
    bodyText: string;
    bodyBase64?: string;
    isBinary?: boolean;
    truncated?: boolean;
  },
  secrets: Iterable<string> = [],
): ResponseExample {
  return sanitizeExample(
    {
      id: exampleDraftId(),
      name: `${response.status} ${response.statusText}`.trim(),
      status: response.status,
      statusText: response.statusText,
      headers: response.headers.map(([key, value]) => ({ key, value, enabled: true })),
      body: response.isBinary ? (response.bodyBase64 ?? "") : response.bodyText,
      ...(response.isBinary ? { bodyEncoding: "base64" as const } : {}),
      ...(response.truncated ? { truncated: true } : {}),
      createdAt: Date.now(),
      originalRequest: exampleRequest(request),
    },
    secrets,
  );
}
export function requestFromExample(example: ResponseExample, fallback: RequestDef): ExampleRequest {
  return exampleRequest(example.originalRequest ?? fallback);
}
