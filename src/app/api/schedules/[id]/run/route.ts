import { runSchedule } from "@/server/scheduler";
import { json, route } from "@/server/http";

export const runtime = "nodejs";
export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return json(await runSchedule(id), 202);
});
