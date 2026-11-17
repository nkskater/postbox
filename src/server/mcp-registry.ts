import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolset } from "@/lib/mcp-toolsets";
import { createPostboxMcpServer } from "./mcp";
import { compactMcpSchema } from "./mcp-schema";
import { toolsetOf } from "./mcp-toolsets";
import { featureOfTool, type FeatureId } from "@/core/features";

type Registration = Parameters<Server["setRequestHandler"]>;
interface Registry {
  handlers: Registration[];
  tools: Tool[];
  listings: Map<string, Tool[]>;
}
const registries = new Map<boolean, Promise<Registry>>();

function registry(readOnly: boolean): Promise<Registry> {
  let pending = registries.get(readOnly);
  if (!pending) {
    pending = (async () => {
      const handlers: Registration[] = [];
      createPostboxMcpServer({
        readOnly,
        onHandler: (...registration) => {
          handlers.push(registration);
        },
      });
      const list = handlers.find(([schema]) => schema === ListToolsRequestSchema)?.[1];
      if (!list) throw new Error("MCP tools/list handler was not registered");
      // SDK discovery reads definitions only, never caller or workspace data.
      const result = (await list(
        { method: "tools/list" },
        {} as Parameters<typeof list>[1],
      )) as ListToolsResult;
      const tools = result.tools.map((tool) => {
        toolsetOf(tool.name);
        const { title: _title, ...definition } = tool;
        return { ...definition, inputSchema: compactMcpSchema(tool.inputSchema) as Tool["inputSchema"] };
      });
      return { handlers, tools, listings: new Map<string, Tool[]>() };
    })();
    registries.set(readOnly, pending);
    void pending.catch(() => {
      if (registries.get(readOnly) === pending) registries.delete(readOnly);
    });
  }
  return pending;
}

/** Cache definitions/handlers only. Protocol, transport, cancellation and caller state are per request. */
export async function createPostboxMcpConnection(options: {
  readOnly: boolean;
  toolsets: McpToolset[];
  /** Feature areas switched off under Settings → Features; their tools are not listed. */
  disabled?: ReadonlySet<FeatureId>;
}): Promise<Server> {
  const compiled = await registry(options.readOnly);
  const disabled = options.disabled ?? new Set<FeatureId>();
  const key = `${options.toolsets.join(",")}|${[...disabled].sort().join(",")}`;
  let tools = compiled.listings.get(key);
  if (!tools) {
    tools = compiled.tools.filter((tool) => {
      const toolset = toolsetOf(tool.name);
      const feature = featureOfTool(tool.name, toolset);
      return options.toolsets.includes(toolset) && !(feature && disabled.has(feature));
    });
    // Bound client-selected combinations; the two compiled registries themselves never grow.
    if (compiled.listings.size >= 32) compiled.listings.delete(compiled.listings.keys().next().value!);
    compiled.listings.set(key, tools);
  }
  const server = new Server(
    { name: "postbox", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, completions: {} },
    },
  );
  for (const [schema, handler] of compiled.handlers) server.setRequestHandler(schema, handler);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  return server;
}
