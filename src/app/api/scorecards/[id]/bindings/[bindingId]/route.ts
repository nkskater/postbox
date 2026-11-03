type Context = { params: Promise<{ id: string; bindingId: string }> };
import { route, json } from "@/server/http";
import { removeQualityService } from "@/server/scorecards";
export const DELETE = route(async (_req: Request, ctx: Context) => {
  const { id, bindingId } = await ctx.params;
  return json(removeQualityService(id, bindingId));
});
