import { applySpecificationSync, syncApplyInput } from "@/server/specification-sync";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(await applySpecificationSync((await ctx.params).id, await parseBody(req, syncApplyInput))),
);
