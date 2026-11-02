import { previewGovernance, checkGovernanceInput } from "@/server/governance";
import { json, route, parseBody } from "@/server/http";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(previewGovernance((await ctx.params).id, await parseBody(req, checkGovernanceInput))),
);
