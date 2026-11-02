/**
 * POST /api/broker/grants/:id/call { method, path, headers?, body?, bodyBase64? } — call the API through the broker.
 * The id is the access reference; only the consumer it was approved for can use it. Postbox adds the credential and
 * never returns it: the response is masked if the API echoes it back.
 */
import { json, parseBody, route } from "@/server/http";
import { call, callInput } from "@/server/broker";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  json(await call((await params).id, await parseBody(req, callInput))),
);
