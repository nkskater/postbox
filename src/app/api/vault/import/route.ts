/**
 * POST /api/vault/import { workspaceId, file, passphrase?, onConflict? } — add the secrets from an export.
 * onConflict for names that already exist: skip (default), replace, or rename (adds -2, -3, ...).
 * Collections are matched by name; a secret whose collection is missing is imported disabled.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { importSecrets } from "@/server/vault";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z
      .object({
        workspaceId: z.string().min(1),
        file: z.unknown(),
        passphrase: z.string().max(256).optional(),
        onConflict: z.enum(["skip", "replace", "rename"]).optional(),
      })
      .strict(),
  );
  return json(importSecrets(input.workspaceId, input.file, input));
});
