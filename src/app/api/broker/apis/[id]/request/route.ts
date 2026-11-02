/** POST /api/broker/apis/:id/request { reason?, bindToKey? } — ask for access; a workspace owner approves it. */
import { json, parseBody, route } from "@/server/http";
import { requestAccess, requestInput } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(requestAccess((await params).id, await parseBody(req, requestInput)), 201),
);
