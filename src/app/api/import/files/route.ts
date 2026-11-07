import { importFiles, importInput } from "@/server/repository";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST { workspaceId, files } — create a new collection from repository files. */
export const POST = route(async (req: Request) => json(importFiles(await parseBody(req, importInput)), 201));
