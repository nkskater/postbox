/**
 * GET  /api/settings/import — download saved settings as JSON.
 * POST /api/settings/import — replace saved settings with an exported file.
 */
import { z } from "zod";
import { exportSettings, importSettings } from "@/server/settings";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route(
  () =>
    new Response(JSON.stringify(exportSettings(), null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="postbox-settings.json"',
      },
    }),
);

export const POST = route(async (req: Request) => {
  const body = await parseBody(req, z.object({ settings: z.record(z.string(), z.unknown()) }));
  const { settings, skipped } = importSettings(body.settings);
  return json({ ...settings, skipped });
});
