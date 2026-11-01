import { z } from "zod";
import { approveScriptPackage } from "@/server/script-packages";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (request: Request, c: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(
    request,
    z.object({ version: z.number().int().positive(), approved: z.boolean() }),
  );
  return json(approveScriptPackage((await c.params).id, input.version, input.approved));
});
