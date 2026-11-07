import { forkInput } from "@/server/forks";
import { json, parseBody, route } from "@/server/http";
import { forkSpecification, listSpecForksOf } from "@/server/spec-forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — forks of this specification that the caller can see. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(listSpecForksOf((await params).id)));

/** POST { workspaceId, name? } — copy the specification into a workspace, remembering where it came from. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(forkSpecification((await params).id, await parseBody(req, forkInput)), 201),
);
