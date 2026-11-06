import { listMentionable } from "@/server/comments";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId= — people who can be @mentioned in this workspace. */
export const GET = route((req: Request) => json(listMentionable(requireParam(req.url, "workspaceId"))));
