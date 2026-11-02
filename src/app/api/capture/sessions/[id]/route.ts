import { deleteSession, getSession, sessionPatch, updateSession } from "@/server/capture";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Context) => json(getSession((await params).id)));
/** PATCH changes settings; `status` pauses (`paused`), resumes (`recording`) or ends (`stopped`) a session. */
export const PATCH = route(async (req: Request, { params }: Context) =>
  json(updateSession((await params).id, await parseBody(req, sessionPatch))),
);
export const DELETE = route(async (_req: Request, { params }: Context) => {
  deleteSession((await params).id);
  return json({ ok: true });
});
