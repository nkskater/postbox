import { exportSpecificationFiles, pushInput, pushSpecificationFiles } from "@/server/repository";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the specification as repository files; its revision is the checksum to push against. */
export const GET = route(async (_req: Request, { params }: Ctx) =>
  json(exportSpecificationFiles((await params).id)),
);

/** PUT { files, baseChecksum, force?, dryRun? } — save edited files as the next revision. */
export const PUT = route(async (req: Request, { params }: Ctx) =>
  json(pushSpecificationFiles((await params).id, await parseBody(req, pushInput))),
);
