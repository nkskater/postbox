import { listMcpCalls, saveMcpCall, mcpSaveSchema } from "@/server/mcp-client";
import { json, parseBody, route, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const id = new URL(req.url).searchParams.get("workspaceId");
  if (!id) throw new HttpError(400, "workspaceId required");
  return json(listMcpCalls(id));
});
export const POST = route(async (req: Request) =>
  json(saveMcpCall(await parseBody(req, mcpSaveSchema)), 201),
);
