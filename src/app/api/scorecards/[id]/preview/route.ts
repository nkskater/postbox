import { route, json, parseBody } from "@/server/http";
import { type Context } from "../../shared";
import { previewScorecard, qualityCheckInput } from "@/server/scorecards";
export const POST = route(async (req: Request, ctx: Context) =>
  json(previewScorecard((await ctx.params).id, await parseBody(req, qualityCheckInput))),
);
