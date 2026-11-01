import { clearEvents, getEvent, listEvents } from "@/server/hook-listeners";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** GET /api/hook-listeners/:id/events[?limit=] or ?event=<id> for one with its body. */
export const GET = route(async (req: Request, { params }: Context) => {
  const { id } = await params;
  const url = new URL(req.url);
  const one = url.searchParams.get("event");
  if (one) return json(getEvent(id, one));
  const limit = Number(url.searchParams.get("limit"));
  return json(listEvents(id, Number.isFinite(limit) && limit > 0 ? limit : undefined));
});

export const DELETE = route(async (_req: Request, { params }: Context) => {
  clearEvents((await params).id);
  return json({ ok: true });
});
