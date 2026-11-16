/** Advertised groups affect discovery only; every call still passes normal authorization. */
export const MCP_TOOLSETS = [
  "core",
  "mocks",
  "monitors",
  "specs",
  "governance",
  "scorecards",
  "datasets",
  "vault-broker",
  "telemetry",
  "catalog-docs",
  "capture",
  "load",
  "packages",
  "graph",
  "comments",
  "examples",
  "codegen",
] as const;
export type McpToolset = (typeof MCP_TOOLSETS)[number];

export function parseMcpToolsets(value: string): McpToolset[] {
  if (value.length > 400) throw new Error("MCP toolsets must be at most 400 characters");
  const names = value.split(",").map((name) => name.trim());
  if (names.length === 1 && names[0] === "all") return [...MCP_TOOLSETS];
  if (names.some((name) => !(MCP_TOOLSETS as readonly string[]).includes(name)))
    throw new Error(`MCP toolsets must be all or a comma-separated selection of: ${MCP_TOOLSETS.join(", ")}`);
  return MCP_TOOLSETS.filter((name) => names.includes(name));
}
