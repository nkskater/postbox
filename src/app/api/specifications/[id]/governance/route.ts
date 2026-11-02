import {
  getSpecificationGovernance,
  bindGovernance,
  bindGovernanceInput,
  unbindGovernance,
} from "@/server/governance";
import { json, route, parseBody } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) =>
  json(getSpecificationGovernance((await ctx.params).id)),
);
export const PUT = route(async (req: Request, ctx: Context) =>
  json(bindGovernance((await ctx.params).id, await parseBody(req, bindGovernanceInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(unbindGovernance((await ctx.params).id)),
);
