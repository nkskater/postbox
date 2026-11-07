import { listReleases, publishEnvironmentRelease, publishInput } from "@/server/dependencies";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — every published version of an environment, newest first. */
export const GET = route(async (_req: Request, { params }: Ctx) =>
  json(listReleases((await params).id, "environment")),
);

/** POST { version, notes?, visibility? } — publish the environment's variables (secret values blanked). */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(publishEnvironmentRelease((await params).id, await parseBody(req, publishInput)), 201),
);
