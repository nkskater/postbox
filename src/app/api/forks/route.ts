import { listForks } from "@/server/forks";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId= — forks living in that workspace, with how far each is from its parent. */
export const GET = route((req: Request) => json(listForks(requireParam(req.url, "workspaceId"))));
