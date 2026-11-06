import { resolveCommentInput } from "@/core/comments/model";
import { setResolved } from "@/server/comments";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** PUT { resolved } — resolve or reopen a thread. */
export const PUT = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { resolved } = await parseBody(req, resolveCommentInput);
  return json(setResolved((await params).id, resolved));
});
