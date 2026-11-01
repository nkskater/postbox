import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { testMockHandler } from "@/server/mocks";

export const dynamic = "force-dynamic";

/**
 * POST /api/mocks/:id/handlers/test — run a handler (a saved one by `handlerId`, or unsaved `code`) against a
 * made-up request in the same sandbox as live traffic. Nothing is stored: pass `state` and `count` to rehearse a
 * later call. Returns { ok, result, state, logs, ms } or { ok:false, error, logs, ms }.
 */
export const POST = route(async (r: Request, c: { params: Promise<{ id: string }> }) =>
  json(
    await testMockHandler(
      (await c.params).id,
      await parseBody(
        r,
        z
          .object({
            handlerId: z.string().max(64).optional(),
            code: z.string().max(16384).optional(),
            request: z
              .object({
                method: z.string().max(16).optional(),
                path: z.string().max(500).optional(),
                query: z
                  .array(z.tuple([z.string().max(500), z.string().max(2000)]))
                  .max(50)
                  .optional(),
                headers: z.record(z.string().max(200), z.string().max(2000)).optional(),
                body: z
                  .string()
                  .max(1024 * 1024)
                  .optional(),
              })
              .strict()
              .optional(),
            state: z.record(z.string(), z.unknown()).optional(),
            count: z.number().int().min(1).max(1_000_000).optional(),
            session: z.string().max(64).optional(),
            exampleId: z.string().max(64).optional(),
          })
          .strict(),
      ),
    ),
  ),
);
