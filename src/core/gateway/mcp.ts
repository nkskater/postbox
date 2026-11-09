import { GatewayPolicyError } from "./model";
const mismatch = () =>
  new GatewayPolicyError("mcp_headers", "MCP header metadata does not match the request body", 400);
function decoded(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw mismatch();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
  } catch {
    throw mismatch();
  }
}

/** Validate standard mirrored metadata without trusting a header in place of message policy. */
export function validateMcpMetadata(headers: Headers, body: Buffer): void {
  if (!body.length) return;
  const value = JSON.parse(body.toString("utf8"));
  const version = headers.get("mcp-protocol-version");
  const modern = !!version && version >= "2026-07-28";
  const method = headers.get("mcp-method"),
    name = headers.get("mcp-name");
  if (Array.isArray(value)) {
    if (modern || method || name) throw mismatch();
    return; // Older revisions can carry batches, whose messages were all policy-checked.
  }
  const bodyVersion = value.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (version && bodyVersion !== undefined && version !== bodyVersion) throw mismatch();
  if (modern && (!method || bodyVersion !== version || typeof value.method !== "string")) throw mismatch();
  if (method && method !== value.method) throw mismatch();
  const expectedName =
    value.method === "resources/read"
      ? value.params?.uri
      : ["tools/call", "prompts/get"].includes(value.method)
        ? value.params?.name
        : undefined;
  if (name && (typeof expectedName !== "string" || decoded(name) !== expectedName)) throw mismatch();
  if (
    modern &&
    ["tools/call", "resources/read", "prompts/get"].includes(value.method) &&
    (!name || typeof expectedName !== "string")
  )
    throw mismatch();
}
