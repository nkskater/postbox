import { cancelRun } from "@/server/runs";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/load-runs/:id/cancel — stop a running or queued test; it keeps the numbers gathered so far. */
export const POST = route(async (_req: Request, { params }: Ctx) =>
  json({ cancelled: cancelRun((await params).id) }),
);
