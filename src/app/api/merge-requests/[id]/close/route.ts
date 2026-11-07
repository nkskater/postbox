import { json, parseBody, route } from "@/server/http";
import { closeInput, closeMergeRequest } from "@/server/forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { note? } — close without merging; the author or a workspace owner. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { note } = await parseBody(req, closeInput);
  return json(closeMergeRequest((await params).id, note));
});
