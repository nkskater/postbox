/** POST /api/broker/grants/:id/deny — turn a request down. */
import { json, route } from "@/server/http";
import { denyAccess } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(denyAccess((await params).id)),
);
