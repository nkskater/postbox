/**
 * GET  /api/vault?workspaceId= — the workspace's secrets: names, descriptions, scope and state. Values are never returned.
 * POST /api/vault { workspaceId, name, value, description?, scriptAccess?, collectionIds? } — store a secret, encrypted.
 *      Reference it as {{vault:name}} in URLs, headers, bodies and auth. `scriptAccess` lets scripts read it with
 *      pm.vault.get(name); `collectionIds` limits it to those collections (empty: the whole workspace).
 */
import { z } from "zod";
import { json, parseBody, requireParam, route } from "@/server/http";
import { createSecret, listSecrets, secretInput } from "@/server/vault";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(listSecrets(requireParam(new URL(req.url), "workspaceId"))));

export const POST = route(async (req: Request) => {
  const { workspaceId, ...rest } = await parseBody(
    req,
    z.object({ workspaceId: z.string().min(1) }).and(z.record(z.string(), z.unknown())),
  );
  return json(createSecret(workspaceId, secretInput.parse(rest)), 201);
});
