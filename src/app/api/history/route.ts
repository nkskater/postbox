import * as repo from "@/server/repo";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(repo.listHistory(requireParam(req.url, "workspaceId"))));

export const DELETE = route((req: Request) => {
  repo.clearHistory(requireParam(req.url, "workspaceId"));
  return json({ ok: true });
});
