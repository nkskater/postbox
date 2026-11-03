import { route, json, parseBody } from "@/server/http";
import { filters, type Context } from "../../shared";
import { saveQualityReport, listQualityReports, qualityCheckInput } from "@/server/scorecards";
export const GET = route(async (req: Request, ctx: Context) =>
  json(listQualityReports((await ctx.params).id, filters(req))),
);
export const POST = route(async (req: Request, ctx: Context) =>
  json(saveQualityReport((await ctx.params).id, await parseBody(req, qualityCheckInput)), 201),
);
