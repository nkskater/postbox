import { revokeRunner } from "@/server/runners";
import { json, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const POST = route(async (_req: Request, c: Context) => json(revokeRunner((await c.params).id)));
