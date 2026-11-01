import { z } from "zod";
import { importDocumentation } from "@/server/documentation";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(req, z.object({ workspaceId: z.string().min(1) }));
  return json(importDocumentation((await params).id, input.workspaceId), 201);
});
