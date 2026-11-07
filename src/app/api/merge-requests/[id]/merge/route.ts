import { json, route } from "@/server/http";
import { mergeMergeRequest } from "@/server/forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST — apply the request to the parent when approved, conflict-free, and the merger may. */
export const POST = route(async (_req: Request, { params }: Ctx) =>
  json(mergeMergeRequest((await params).id)),
);
