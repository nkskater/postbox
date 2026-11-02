import { openMcpSession, mcpConnectSchema, endMcpSession } from "@/server/mcp-client";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request) => {
  const session = await openMcpSession(await parseBody(req, mcpConnectSchema));
  if (req.signal.aborted) {
    await endMcpSession(session.id);
    return json({ error: "Connection cancelled" }, 499);
  }
  return json(session, 201);
});
