import { route, json } from "@/server/http";
import { type Context } from "../../shared";
import { scorecardSources } from "@/server/scorecards";
export const GET = route(async (_req: Request, ctx: Context) =>
  json(scorecardSources((await ctx.params).id)),
);
