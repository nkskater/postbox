/** GET /api/load-runs/:id — the stored test: profile, thresholds and the full result (with the time series). DELETE removes it. */
import { deleteLoadRun, getLoadRun } from "@/server/load";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getLoadRun((await params).id)));

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  deleteLoadRun((await params).id);
  return json({ deleted: true });
});
