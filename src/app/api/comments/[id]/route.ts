import { editCommentInput } from "@/core/comments/model";
import { deleteComment, editComment, getComment } from "@/server/comments";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getComment((await params).id)));

/** PATCH { body } — only the author may edit. */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { body } = await parseBody(req, editCommentInput);
  return json(editComment((await params).id, body));
});

/** DELETE — the author or a workspace owner; deleting a thread deletes its replies. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => json(deleteComment((await params).id)));
