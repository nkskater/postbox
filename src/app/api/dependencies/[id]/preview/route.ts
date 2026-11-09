import { previewUpdate } from "@/server/dependencies";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET ?releaseId= — what updating to that release (default: the newest) would change, and any conflicts. */
export const GET = route(async (req: Request, { params }: Ctx) =>
  json(previewUpdate((await params).id, new URL(req.url).searchParams.get("releaseId") ?? undefined)),
);
