/**
 * POST /api/proxy — execute a request server-side (scripts, variables, auth, cookies)
 * and return the response, test results, console output and timing.
 */
import { z } from "zod";
import type { RequestDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { runSingleRequest } from "@/server/context";
import { json, parseBody, route } from "@/server/http";
import { defaultRequest } from "@/server/defaults";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  requestId: z.string().nullish(),
  request: z.record(z.string(), z.unknown()),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const r = input.request as unknown as Partial<RequestDef>;
  const request = defaultRequest({
    ...r,
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
  } as Partial<RequestDef>);
  const result = await runSingleRequest({
    workspaceId: input.workspaceId,
    environmentId: input.environmentId ?? null,
    folderId: input.folderId ?? null,
    requestId: input.requestId ?? null,
    request,
    signal: req.signal,
  });
  return json(result);
});
