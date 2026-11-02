/** POST /api/broker/grants/:id/revoke — end access at once. The consumer it belongs to or a workspace owner may do it. */
import { json, route } from "@/server/http";
import { revokeAccess } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(revokeAccess((await params).id)),
);
