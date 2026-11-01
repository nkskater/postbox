/**
 * POST /api/proxy — execute a request server-side (scripts, variables, auth, cookies)
 * and return the response, test results, console output and timing.
 */
import { z } from "zod";
import { DEFAULT_SETTINGS } from "@/core/types";
import { runSingleRequest } from "@/server/context";
import { json, parseBody, route } from "@/server/http";
import { defaultRequest } from "@/server/defaults";
import { requestInputSchema } from "@/core/schemas";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  requestId: z.string().nullish(),
  request: requestInputSchema,
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const r = input.request;
  const request = defaultRequest({ ...r, settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } });
  const result = await runSingleRequest({
    workspaceId: input.workspaceId,
    environmentId: input.environmentId ?? null,
    folderId: input.folderId ?? null,
    requestId: input.requestId ?? null,
    request,
    signal: req.signal,
    idempotencyKey: req.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined,
  });
  return json(result);
});
