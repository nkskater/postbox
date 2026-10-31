/**
 * Encode a (variable-resolved) BodyConfig into bytes plus a default Content-Type.
 */
import { randomBytes } from "node:crypto";
import type { BodyConfig, RawLanguage } from "../types";

export interface EncodedBody {
  body?: Buffer;
  /** Content-Type to use if the user did not set one explicitly. */
  contentType?: string;
}

const RAW_CONTENT_TYPES: Record<RawLanguage, string> = {
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  text: "text/plain",
};

export function encodeBody(body: BodyConfig, method: string): EncodedBody {
  switch (body.mode) {
    case "none":
      return {};
    case "raw":
      if (!body.raw && (method === "GET" || method === "HEAD")) return {};
      return {
        body: Buffer.from(body.raw ?? "", "utf8"),
        contentType: RAW_CONTENT_TYPES[body.language] ?? "text/plain",
      };
    case "urlencoded": {
      const params = new URLSearchParams();
      for (const kv of body.urlencoded ?? []) if (kv.enabled && kv.key) params.append(kv.key, kv.value);
      return {
        body: Buffer.from(params.toString(), "utf8"),
        contentType: "application/x-www-form-urlencoded",
      };
    }
    case "formdata":
      return encodeMultipart(body.formdata ?? []);
    case "binary":
      if (!body.binary) return {};
      if (body.binary.missing) throw new Error("Re-select the binary file before sending this request");
      return {
        body: Buffer.from(body.binary.data, "base64"),
        contentType: body.binary.contentType || "application/octet-stream",
      };
    case "graphql": {
      const g = body.graphql;
      let variables: unknown = undefined;
      if (g.variables?.trim()) {
        try {
          variables = JSON.parse(g.variables);
        } catch {
          throw new Error("GraphQL variables are not valid JSON");
        }
      }
      const payload: Record<string, unknown> = { query: g.query };
      if (variables !== undefined) payload.variables = variables;
      if (g.operationName) payload.operationName = g.operationName;
      return { body: Buffer.from(JSON.stringify(payload), "utf8"), contentType: "application/json" };
    }
    default:
      return {};
  }
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, "%22").replace(/\r?\n/g, " ");
}

/** Build a multipart/form-data payload. File fields carry base64 data inline. */
export function encodeMultipart(fields: Extract<BodyConfig, { mode: "formdata" }>["formdata"]): EncodedBody {
  const boundary = `----PostboxFormBoundary${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const f of fields) {
    if (!f.enabled || !f.key) continue;
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(f.key)}"`;
    if (f.type === "file") {
      if (f.missing) throw new Error(`Re-select the file for form-data field "${f.key}" before sending`);
      head += `; filename="${escapeQuotes(f.fileName || "file")}"\r\nContent-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`;
      parts.push(Buffer.from(head, "utf8"), Buffer.from(f.data ?? "", "base64"), Buffer.from("\r\n"));
    } else {
      head += "\r\n\r\n";
      parts.push(Buffer.from(head + f.value + "\r\n", "utf8"));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
