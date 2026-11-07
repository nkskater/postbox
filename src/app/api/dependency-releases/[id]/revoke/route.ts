import { revokeInput, revokeRelease } from "@/server/dependencies";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { reason } — withdraw a version: it can no longer be installed or updated to, and installs are flagged. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { reason } = await parseBody(req, revokeInput);
  return json(revokeRelease((await params).id, reason));
});
