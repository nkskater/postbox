import { updateInput, updateInstall } from "@/server/dependencies";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { releaseId?, strategy? } — move to a release, keeping local edits and credentials. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(updateInstall((await params).id, await parseBody(req, updateInput))),
);
