import { getRuleSet, saveRuleSet, saveRuleSetInput, deleteRuleSet } from "@/server/governance";
import { json, route, parseBody } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (req: Request, ctx: Context) => {
  const query = new URL(req.url).searchParams;
  return json(
    getRuleSet((await ctx.params).id, query.has("version") ? Number(query.get("version")) : undefined),
  );
});
export const PATCH = route(async (req: Request, ctx: Context) =>
  json(saveRuleSet((await ctx.params).id, await parseBody(req, saveRuleSetInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(deleteRuleSet((await ctx.params).id)),
);
