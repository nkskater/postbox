import { z } from "zod";
import type { RequestDef } from "@/core/types";
import * as repo from "@/server/repo";
import { HttpError, json, parseBody, route } from "@/server/http";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      folderId: z.string(),
      request: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  if (!repo.getFolder(input.folderId)) throw new HttpError(400, "Folder does not exist");
  const { id: _id, ...partial } = (input.request ?? {}) as Partial<RequestDef>;
  return json(repo.createRequest(input.workspaceId, input.folderId, partial), 201);
});
