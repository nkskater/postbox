import { exportFiles, pushFiles, pushInput } from "@/server/repository";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the collection as stable, secret-free repository files, with the checksum to push against. */
export const GET = route(async (_req: Request, { params }: Ctx) => json(exportFiles((await params).id)));

/** PUT { files, baseChecksum, prune?, force?, dryRun? } — apply edited files back to the collection. */
export const PUT = route(async (req: Request, { params }: Ctx) =>
  json(pushFiles((await params).id, await parseBody(req, pushInput))),
);
