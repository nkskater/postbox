import { json, parseBody, route } from "@/server/http";
import { previewSync, syncFork, syncInput } from "@/server/forks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — what pulling the parent's changes into the fork would do. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(previewSync((await params).id)));

/** POST { strategy? } — pull the parent's changes into the fork, keeping the fork's own edits. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { strategy } = await parseBody(req, syncInput);
  return json(syncFork((await params).id, strategy));
});
