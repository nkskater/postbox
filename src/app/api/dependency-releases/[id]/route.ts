import { getRelease } from "@/server/dependencies";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getRelease((await params).id)));
