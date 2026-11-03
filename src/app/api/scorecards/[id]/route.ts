import { route, json, parseBody } from "@/server/http";
import { type Context } from "../shared";
import { getScorecard, saveScorecard, saveScorecardInput, deleteScorecard } from "@/server/scorecards";
export const GET = route(async (req: Request, ctx: Context) => {
  const version = new URL(req.url).searchParams.get("version");
  return json(getScorecard((await ctx.params).id, version === null ? undefined : Number(version)));
});
export const PATCH = route(async (req: Request, ctx: Context) =>
  json(saveScorecard((await ctx.params).id, await parseBody(req, saveScorecardInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(deleteScorecard((await ctx.params).id)),
);
