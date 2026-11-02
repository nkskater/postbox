import { getGovernanceReport } from "@/server/governance";
import { json, route } from "@/server/http";
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string; reportId: string }> }) => {
    const { id, reportId } = await ctx.params;
    return json(getGovernanceReport(id, reportId));
  },
);
