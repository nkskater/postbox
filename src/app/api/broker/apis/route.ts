/**
 * GET  /api/broker/apis?workspaceId= — APIs registered with the credential broker.
 * POST /api/broker/apis { workspaceId, name, baseUrl, secretName, injection?, methods?, pathPrefixes? } — register one.
 *      `secretName` is a workspace vault secret; the broker injects it, consumers never see it.
 */
import { z } from "zod";
import { json, parseBody, requireParam, route } from "@/server/http";
import { apiInput, createApi, listApis } from "@/server/broker";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(listApis(requireParam(new URL(req.url), "workspaceId"))));

export const POST = route(async (req: Request) => {
  const { workspaceId, ...rest } = await parseBody(
    req,
    z.object({ workspaceId: z.string().min(1) }).and(z.record(z.string(), z.unknown())),
  );
  return json(createApi(workspaceId, apiInput.parse(rest)), 201);
});
