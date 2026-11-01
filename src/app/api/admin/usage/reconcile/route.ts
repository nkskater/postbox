/**
 * POST /api/admin/usage/reconcile { from?, to?, workspaceId?, repair? } — compare the usage ledger with the
 * run history for a period (default: this month). With repair, missing entries are added and wrong amounts
 * corrected; running it again changes nothing. Administrators only.
 */
import { z } from "zod";
import { periodEnd, periodStart } from "@/core/usage";
import { json, parseBody, route } from "@/server/http";
import { reconcileRuns } from "@/server/usage";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z
      .object({
        from: z.number().optional(),
        to: z.number().optional(),
        workspaceId: z.string().optional(),
        repair: z.boolean().optional(),
      })
      .strict(),
  );
  const now = Date.now();
  return json(
    reconcileRuns({
      from: input.from ?? periodStart("month", now),
      to: input.to ?? periodEnd("month", now),
      workspaceId: input.workspaceId,
      repair: input.repair,
    }),
  );
});
