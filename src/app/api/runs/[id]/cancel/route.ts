import { cancelRun } from "@/server/runs";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json({ cancelled: cancelRun(id) });
});
