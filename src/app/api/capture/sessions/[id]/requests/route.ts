import { createRequests, createRequestsInput } from "@/server/capture";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** POST turns the selected entries into requests in a new folder. Credentials must be added again. */
export const POST = route(async (req: Request, { params }: Context) =>
  json(createRequests((await params).id, await parseBody(req, createRequestsInput)), 201),
);
