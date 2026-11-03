type Context = { params: Promise<{ id: string; reportId: string }> };
import { route, json } from "@/server/http";
import { filters } from "../../../shared";
import { getQualityReport } from "@/server/scorecards";
export const GET = route(async (req: Request, ctx: Context) => {
  const { id, reportId } = await ctx.params;
  return json(getQualityReport(id, reportId, filters(req)));
});
