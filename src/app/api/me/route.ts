/** GET /api/me — the signed-in caller (account, env admin or open mode). */
import { callerOf, describeCaller } from "@/server/caller";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(describeCaller(callerOf(req))));
