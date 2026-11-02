import { getMcpCall, updateMcpCall, deleteMcpCall, mcpPatchSchema } from "@/server/mcp-client";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, c: Context) => json(getMcpCall((await c.params).id)));
export const PATCH = route(async (req: Request, c: Context) =>
  json(updateMcpCall((await c.params).id, await parseBody(req, mcpPatchSchema))),
);
export const DELETE = route(async (_req: Request, c: Context) => json(deleteMcpCall((await c.params).id)));
