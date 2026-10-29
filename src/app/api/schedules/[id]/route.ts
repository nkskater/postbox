import { deleteSchedule, schedulePatch, updateSchedule } from "@/server/scheduler";
import { json, parseBody, route } from "@/server/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, { params }: Context) => {
  const { id } = await params;
  return json(updateSchedule(id, await parseBody(req, schedulePatch)));
});

export const DELETE = route(async (_req: Request, { params }: Context) => {
  const { id } = await params;
  deleteSchedule(id);
  return json({ ok: true });
});
