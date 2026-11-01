import { deleteListener, getListener, listenerPatch, updateListener } from "@/server/hook-listeners";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Context) => json(getListener((await params).id)));
/** PATCH changes settings; `status` pauses (`paused`), resumes (`active`) or permanently revokes (`revoked`). */
export const PATCH = route(async (req: Request, { params }: Context) =>
  json(updateListener((await params).id, await parseBody(req, listenerPatch))),
);
export const DELETE = route(async (_req: Request, { params }: Context) => {
  deleteListener((await params).id);
  return json({ ok: true });
});
