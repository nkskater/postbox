import { json, parseBody, route } from "@/server/http";
import { openMergeRequest, openMergeRequestInput } from "@/server/forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { title, description? } — propose the fork's changes to its parent collection. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(openMergeRequest((await params).id, await parseBody(req, openMergeRequestInput)), 201),
);
