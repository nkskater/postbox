import { route, json, parseBody } from "@/server/http";
import { type Context } from "../../shared";
import { compareQualityReports, qualityCompareInput } from "@/server/scorecards";
export const POST = route(async (req: Request, ctx: Context) =>
  json(compareQualityReports((await ctx.params).id, await parseBody(req, qualityCompareInput))),
);
