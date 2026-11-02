/** GET /api/broker/grants/:id — one access grant (its owner or a workspace owner). */
import { json, route } from "@/server/http";
import { getGrant } from "@/server/broker";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(getGrant((await params).id)),
);
