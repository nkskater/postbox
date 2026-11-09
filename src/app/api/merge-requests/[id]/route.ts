import { getMergeRequest } from "@/server/forks";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the request with its structural diff, conflicts, protected changes, reviews and readiness. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(getMergeRequest((await params).id)));
