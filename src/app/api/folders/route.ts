import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, route } from "@/server/http";

/** Create a collection (parentId null) or a folder. */
export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      parentId: z.string().nullish(),
      name: z.string().min(1).max(300).optional(),
    }),
  );
  return json(
    repo.createFolder(input.workspaceId, input.parentId ?? null, input.name ? { name: input.name } : {}),
    201,
  );
});
