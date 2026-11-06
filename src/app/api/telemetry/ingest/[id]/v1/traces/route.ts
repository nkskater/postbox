import { route } from "@/server/http";
import { telemetryIntake } from "@/server/telemetry-http";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  telemetryIntake(req, (await ctx.params).id),
);
