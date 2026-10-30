import { includeRunDetails } from "@/server/run-details";
import { deleteRun, getRunSummary } from "@/server/runs";
import { json, notFound, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const run = getRunSummary(id);
  if (!run) throw notFound("Run");
  return json(includeRunDetails(run));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  deleteRun(id);
  return json({ ok: true });
});
