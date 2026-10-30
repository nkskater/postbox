/** GET /api/me — the signed-in caller (account, env admin or open mode). */
import { callerOf, describeCaller } from "@/server/caller";
import { listWorkspaces } from "@/server/repo";
import { getSqlite } from "@/server/db";
import { workspaceRole } from "@/server/authorize";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const caller = callerOf(req);
  return json({
    ...describeCaller(caller),
    workspaces: listWorkspaces().map((workspace) => ({
      id: workspace.id,
      role: workspaceRole(caller ?? undefined, workspace.id),
      memberCount: (
        getSqlite()
          .prepare("SELECT count(*) AS n FROM workspace_members WHERE workspace_id = ?")
          .get(workspace.id) as { n: number }
      ).n,
    })),
  });
});
