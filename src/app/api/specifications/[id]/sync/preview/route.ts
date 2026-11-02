import { previewSpecificationSync, syncPreviewInput } from "@/server/specification-sync";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(await previewSpecificationSync((await ctx.params).id, await parseBody(req, syncPreviewInput))),
);
