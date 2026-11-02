import { listGovernanceReports, saveGovernanceReport, checkGovernanceInput } from "@/server/governance";
import { json, route, parseBody } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) =>
  json(listGovernanceReports((await ctx.params).id)),
);
export const POST = route(async (req: Request, ctx: Context) =>
  json(saveGovernanceReport((await ctx.params).id, await parseBody(req, checkGovernanceInput)), 201),
);
