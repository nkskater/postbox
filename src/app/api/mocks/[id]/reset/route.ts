import { z } from "zod";
import { resetMockState } from "@/server/mocks";
import { route, json, parseBody } from "@/server/http";

/** POST /api/mocks/:id/reset — restart failure-simulation counters: { session? } (all sessions when omitted). */
export const POST = route(async (r: Request, c: { params: Promise<{ id: string }> }) => {
  const { session } = await parseBody(r, z.object({ session: z.string().max(64).optional() }));
  return json(resetMockState((await c.params).id, session));
});
