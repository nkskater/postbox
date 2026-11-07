import { json, parseBody, route } from "@/server/http";
import { reviewInput, reviewMergeRequest } from "@/server/forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { decision: approve | reject, note? } — review the fork's current content; it goes stale if the fork changes. */
export const POST = route(async (req: Request, { params }: Ctx) =>
  json(reviewMergeRequest((await params).id, await parseBody(req, reviewInput)), 201),
);
