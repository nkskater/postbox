import { historySettings } from "@/server/execution-settings";
import * as repo from "@/server/repo";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  // Apply a shortened retention period straight away rather than at the next request.
  repo.purgeExpiredHistory(historySettings().retentionDays);
  return json(repo.listHistory(requireParam(req.url, "workspaceId")));
});

export const DELETE = route((req: Request) => {
  repo.clearHistory(requireParam(req.url, "workspaceId"));
  return json({ ok: true });
});
