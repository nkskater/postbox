import { listReleases, publishInput, publishRelease } from "@/server/dependencies";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — every published version of a collection, newest first. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(listReleases((await params).id)));

/** POST { version, notes?, visibility? } — publish the collection's current state as an immutable version. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(publishRelease((await params).id, await parseBody(req, publishInput)), 201),
);
