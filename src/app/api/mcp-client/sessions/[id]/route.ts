import { closeMcpSession, runMcpAction, mcpRunSchema } from "@/server/mcp-client";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const POST = route(async (req: Request, c: Context) =>
  json(await runMcpAction((await c.params).id, (await parseBody(req, mcpRunSchema)).action)),
);
export const DELETE = route(async (_req: Request, c: Context) =>
  json(await closeMcpSession((await c.params).id)),
);
