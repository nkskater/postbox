import { forkCollection, forkInput, listForksOf } from "@/server/forks";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — forks of this collection that the caller can see. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(listForksOf((await params).id)));

/** POST { workspaceId, name? } — copy the collection into a workspace, remembering where it came from. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(forkCollection((await params).id, await parseBody(req, forkInput)), 201),
);
