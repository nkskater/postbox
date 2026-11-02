import { z } from "zod";
const jsonObject = z.record(z.string().max(1024), z.unknown()).refine((value) => {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (depth > 32 || ++nodes > 10000) return false;
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    } else if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      (!["string", "number", "boolean"].includes(typeof item) && item !== null)
    )
      return false;
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 262144;
}, "MCP arguments must be JSON within 256 KiB, 32 levels and 10000 nodes");
export const mcpConnectionSchema = z.object({
  url: z.string().min(1).max(8192),
  headers: z
    .array(z.object({ key: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), value: z.string().max(8192) }))
    .max(50)
    .default([]),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
});
export const mcpActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["tools/list", "resources/list", "resources/templates/list", "prompts/list"]),
    cursor: z.string().max(8192).optional(),
  }),
  z.object({
    type: z.literal("tools/call"),
    name: z.string().min(1).max(1024),
    arguments: jsonObject.default({}),
  }),
  z.object({ type: z.literal("resources/read"), uri: z.string().min(1).max(8192) }),
  z.object({
    type: z.literal("prompts/get"),
    name: z.string().min(1).max(1024),
    arguments: z
      .record(z.string().max(1024), z.string().max(8192))
      .refine((v) => Object.keys(v).length <= 100)
      .default({}),
  }),
]);
export const mcpCallSchema = z.object({
  name: z.string().trim().min(1).max(200),
  connection: mcpConnectionSchema,
  action: mcpActionSchema,
});
export type McpConnectionConfig = z.infer<typeof mcpConnectionSchema>;
export type McpAction = z.infer<typeof mcpActionSchema>;
export type McpCall = z.infer<typeof mcpCallSchema>;
