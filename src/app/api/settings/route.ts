/**
 * GET   /api/settings — effective values, saved values, defaults, env-locked keys, env-only settings.
 * PATCH /api/settings — { values: { key: value | null } } (null resets to default).
 */
import { z } from "zod";
import { getSettings, patchSettings } from "@/server/settings";
import { HttpError, json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route(() => json(getSettings()));

export const PATCH = route(async (req: Request) => {
  const { values } = await parseBody(req, z.object({ values: z.record(z.string(), z.unknown()) }));
  try {
    return json(patchSettings(values));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});
