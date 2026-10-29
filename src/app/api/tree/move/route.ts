import { z } from "zod";
import * as repo from "@/server/repo";
import { HttpError, json, parseBody, route } from "@/server/http";

/** Drag & drop: move a folder/request to a new parent and position. */
export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      kind: z.enum(["folder", "request"]),
      id: z.string(),
      parentId: z.string().nullable(),
      index: z.number().int().min(0),
    }),
  );
  try {
    repo.reorder(input.kind, input.id, input.parentId, input.index);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return json({ ok: true });
});
