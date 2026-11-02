/**
 * POST /api/broker/apis/:id/grant { consumerId, methods?, pathPrefixes?, expiresInSec?, tokenId? } — approve access for
 * a workspace member (or service account) directly, without waiting for a request.
 */
import { json, parseBody, route } from "@/server/http";
import { grantAccess, grantInput } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(grantAccess((await params).id, await parseBody(req, grantInput)), 201),
);
