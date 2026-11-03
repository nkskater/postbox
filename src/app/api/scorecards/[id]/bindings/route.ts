import { route, json, parseBody } from "@/server/http";
import { type Context } from "../../shared";
import { bindQualityService, qualityBindingInput } from "@/server/scorecards";
export const PUT = route(async (req: Request, ctx: Context) =>
  json(bindQualityService((await ctx.params).id, await parseBody(req, qualityBindingInput))),
);
