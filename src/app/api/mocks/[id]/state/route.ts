import { inspectMockState } from "@/server/mocks";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET /api/mocks/:id/state — per-session handler state and call counts (in memory; restarts clear it). */
export const GET = route(async (_r: Request, c: { params: Promise<{ id: string }> }) =>
  json(inspectMockState((await c.params).id)),
);
