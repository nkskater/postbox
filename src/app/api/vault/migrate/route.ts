/**
 * POST /api/vault/migrate { workspaceId, scriptAccess? } — move the values of secret-type variables into the vault
 * and leave a {{vault:name}} reference in each variable. Scripts then read those variables as the reference, not the
 * value, unless `scriptAccess` is true (then pm.vault.get(name) works). Returns what moved and what was skipped.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { migrateSecretVariables } from "@/server/vault";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({ workspaceId: z.string().min(1), scriptAccess: z.boolean().optional() }).strict(),
  );
  return json(migrateSecretVariables(input.workspaceId, { scriptAccess: input.scriptAccess }));
});
