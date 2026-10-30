import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, route } from "@/server/http";
import { requestInputSchema } from "@/core/schemas";
import { DEFAULT_SETTINGS } from "@/core/types";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      folderId: z.string(),
      request: requestInputSchema.optional(),
    }),
  );
  const { id: _id, settings, ...partial } = input.request ?? {};
  return json(
    repo.createRequest(input.workspaceId, input.folderId, {
      ...partial,
      ...(settings ? { settings: { ...DEFAULT_SETTINGS, ...settings } } : {}),
    }),
    201,
  );
});
