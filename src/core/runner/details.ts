import type { ExecuteResult } from "../executor";
import type { Timings } from "../types";
import { credentialRedactionValues, sensitiveFieldValues } from "../retention";
import { redactStoredValue } from "../variables/resolver";

export interface RecordedBody {
  text?: string;
  state: "complete" | "truncated" | "unavailable";
  reason?: string;
}

export interface ExecutionDetails {
  request?: {
    method: string;
    url: string;
    headers: [string, string][];
    body: RecordedBody;
    bodySize: number;
  };
  response?: {
    url: string;
    headers: [string, string][];
    contentType: string;
    body: RecordedBody;
    timings: Timings;
  };
}

/** Retain readable text only; redact before applying the retention bound. */
export function recordExecution(
  result: ExecuteResult,
  secrets: string[],
  responseLimit = 1024 * 1024,
  requestBinary = false,
): ExecutionDetails {
  const sent = result.sent;
  const response = result.response;
  const derivedSecrets: string[] = [];
  for (const [name, value] of sent?.headers ?? []) {
    if (!/authorization|cookie|token|password|secret|api[-_]?key|credential/i.test(name)) continue;
    derivedSecrets.push(value);
    if (/^authorization$/i.test(name)) {
      const separator = value.indexOf(" ");
      if (separator >= 0) {
        const credential = value.slice(separator + 1);
        derivedSecrets.push(credential);
        if (/^Basic$/i.test(value.slice(0, separator))) {
          const decoded = Buffer.from(credential, "base64").toString("utf8");
          derivedSecrets.push(decoded);
          const colon = decoded.indexOf(":");
          if (colon >= 0) derivedSecrets.push(decoded.slice(0, colon), decoded.slice(colon + 1));
        }
      }
    }
    if (/cookie/i.test(name))
      for (const part of value.split(";")) {
        const equals = part.indexOf("=");
        if (equals >= 0) derivedSecrets.push(part.slice(equals + 1).trim());
      }
  }
  if (sent?.url) {
    try {
      for (const [name, value] of new URL(sent.url).searchParams) {
        if (/authorization|cookie|token|password|secret|api[-_]?key|credential/i.test(name))
          derivedSecrets.push(value);
      }
    } catch {
      // The request URL error is reported separately; retain only known values.
    }
  }
  derivedSecrets.push(...sensitiveFieldValues(sent?.body ?? ""));
  const directSecrets = [...secrets, ...derivedSecrets];
  const allSecrets = credentialRedactionValues(directSecrets);
  const safe = <T>(value: T): T => redactStoredValue(value, allSecrets);
  return {
    request: sent
      ? {
          method: safe(sent.method),
          url: safe(sent.url),
          headers: safe(sent.headers),
          bodySize: sent.bodySize,
          body:
            requestBinary || sent.bodySize > 64 * 1024 || (sent.bodySize > 0 && sent.body === undefined)
              ? {
                  state: "unavailable",
                  reason: requestBinary
                    ? "Uploaded request body was not retained as text."
                    : "Request body was not retained in full (64 KB recording limit).",
                }
              : { state: "complete", text: safe(sent.body ?? "") },
        }
      : undefined,
    response: response
      ? {
          url: safe(response.url),
          headers: safe(response.headers),
          contentType: response.contentType,
          timings: response.timings,
          body: response.isBinary
            ? { state: "unavailable", reason: "Binary response body was not retained as text." }
            : (() => {
                let captured = response.bodyText;
                // A capture boundary can bisect a secret; discard its trailing prefix too.
                if (response.truncated) {
                  for (const secret of directSecrets.filter(Boolean)) {
                    for (let length = Math.min(secret.length - 1, captured.length); length > 0; length--) {
                      if (captured.endsWith(secret.slice(0, length))) {
                        captured = captured.slice(0, -length);
                        break;
                      }
                    }
                  }
                }
                const text = safe(captured);
                const bytes = Buffer.from(text, "utf8");
                const limited = bytes.length > responseLimit;
                return {
                  text: limited
                    ? new TextDecoder().decode(bytes.subarray(0, responseLimit), { stream: true })
                    : text,
                  state: response.truncated || limited ? ("truncated" as const) : ("complete" as const),
                  reason: response.truncated
                    ? "Response capture was truncated at the configured size limit. Only the captured portion is available."
                    : limited
                      ? "Response body was truncated at the 1 MB recording limit."
                      : undefined,
                };
              })(),
        }
      : undefined,
  };
}
