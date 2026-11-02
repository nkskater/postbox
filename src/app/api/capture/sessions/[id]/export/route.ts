import { exportHar } from "@/server/capture";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** GET /api/capture/sessions/:id/export[?entries=a,b] — the recording as HAR 1.2 (credentials already removed). */
export const GET = route(async (req: Request, { params }: Context) => {
  const ids = new URL(req.url).searchParams.get("entries");
  const har = exportHar((await params).id, ids ? ids.split(",").filter(Boolean).slice(0, 500) : undefined);
  return new Response(JSON.stringify(har, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="postbox-capture.har"',
      "Cache-Control": "no-store",
    },
  });
});
