/** POST /api/broker/grants/:id/approve { methods?, pathPrefixes?, expiresInSec?, tokenId? } — approve a request, with limits. */
import { json, parseBody, route } from "@/server/http";
import { approveAccess, approveInput } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(approveAccess((await params).id, await parseBody(req, approveInput))),
);
