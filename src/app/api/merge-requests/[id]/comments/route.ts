import { createCommentInput } from "@/core/comments/model";
import { createComment, listComments } from "@/server/comments";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the review discussion on this merge request. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json(listComments("mergeRequest", id, new URL(req.url).searchParams.get("open") !== "1"));
});

/** POST { body, parentId? } — add a comment, or reply to a top-level one. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const input = await parseBody(req, createCommentInput.omit({ targetKind: true, targetId: true }));
  return json(createComment({ targetKind: "mergeRequest", targetId: id, ...input }), 201);
});
