import { listReleases, publishInput, publishMockRelease } from "@/server/dependencies";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — every published version of a mock server, newest first. */
export const GET = route(async (_req: Request, { params }: Ctx) =>
  json(listReleases((await params).id, "mock")),
);

/** POST { version, notes?, visibility? } — publish the mock's settings, scenarios and handlers (no key, no routes). */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(publishMockRelease((await params).id, await parseBody(req, publishInput)), 201),
);
