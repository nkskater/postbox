import { getInstall, removeInstall } from "@/server/dependencies";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getInstall((await params).id)));

/** DELETE ?deleteCopy=1 — stop tracking; the local collection is kept unless deleteCopy is set. */
export const DELETE = route(async (req: Request, { params }: Ctx) =>
  json(removeInstall((await params).id, new URL(req.url).searchParams.get("deleteCopy") === "1")),
);
