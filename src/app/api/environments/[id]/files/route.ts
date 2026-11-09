import { exportEnvironmentFiles, pushEnvironmentFiles, pushInput } from "@/server/repository";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the environment as repository files (secret values blank), with the checksum to push against. */
export const GET = route(async (_req: Request, { params }: Ctx) =>
  json(exportEnvironmentFiles((await params).id)),
);

/** PUT { files, baseChecksum, prune?, force?, dryRun? } — apply edited files back to the environment. */
export const PUT = route(async (req: Request, { params }: Ctx) =>
  json(pushEnvironmentFiles((await params).id, await parseBody(req, pushInput))),
);
