/**
 * GET /api/admin/usage/limits — every quota.
 * PUT /api/admin/usage/limits { workspaceId?, userId?, metric, period?, softLimit?, hardLimit? } — create or
 *     replace one. No workspace and no user sets the default for every workspace; a workspace overrides it;
 *     a user (person or service account) caps that identity across workspaces. Null clears a limit.
 * Administrators only.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { listLimits, setLimit } from "@/server/usage";

export const dynamic = "force-dynamic";

export const GET = route((_req: Request) => json(listLimits()));

export const PUT = route(async (req: Request) =>
  json(
    setLimit(
      await parseBody(
        req,
        z
          .object({
            workspaceId: z.string().min(1).nullish(),
            userId: z.string().min(1).nullish(),
            metric: z.string(),
            period: z.string().optional(),
            softLimit: z.number().nullish(),
            hardLimit: z.number().nullish(),
          })
          .strict(),
      ),
    ),
  ),
);
