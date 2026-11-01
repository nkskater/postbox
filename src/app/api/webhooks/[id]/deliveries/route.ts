import { getDelivery, listDeliveries } from "@/server/webhooks";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** GET /api/webhooks/:id/deliveries[?status=&limit=] or ?delivery=<id> for one with its attempts. */
export const GET = route(async (req: Request, { params }: Context) => {
  const { id } = await params;
  const url = new URL(req.url);
  const one = url.searchParams.get("delivery");
  if (one) return json(getDelivery(id, one));
  const limit = Number(url.searchParams.get("limit"));
  return json(
    listDeliveries(id, {
      status: url.searchParams.get("status") || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }),
  );
});
