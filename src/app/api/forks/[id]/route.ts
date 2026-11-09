import { getFork, removeFork } from "@/server/forks";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getFork((await params).id)));

/** DELETE ?deleteCopy=1 — stop tracking the fork (and drop its merge requests); the collection stays unless asked. */
export const DELETE = route(async (req: Request, { params }: Ctx) =>
  json(removeFork((await params).id, new URL(req.url).searchParams.get("deleteCopy") === "1")),
);
