import { listMockLogs, clearMockLogs } from "@/server/mocks";
import { route, json } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_r: Request, c: Context) => json(listMockLogs((await c.params).id)));
export const DELETE = route(async (_r: Request, c: Context) => json(clearMockLogs((await c.params).id)));
