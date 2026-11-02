/**
 * POST /api/vault/export { workspaceId, passphrase, includePersonal? } — download the workspace's secrets as a
 * passphrase-protected file (AES-256-GCM, scrypt). A plaintext file needs { plaintext: true, acknowledgePlaintext: true }.
 * Workspace owners only. Collections travel by name.
 */
import { z } from "zod";
import { HttpError } from "@/server/errors";
import { parseBody, route } from "@/server/http";
import { exportSecrets } from "@/server/vault";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z
      .object({
        workspaceId: z.string().min(1),
        passphrase: z.string().min(1).max(256).optional(),
        includePersonal: z.boolean().optional(),
        plaintext: z.boolean().optional(),
        acknowledgePlaintext: z.boolean().optional(),
      })
      .strict(),
  );
  if (input.plaintext && !input.acknowledgePlaintext)
    throw new HttpError(
      400,
      "A plaintext export puts every value in the file. Set acknowledgePlaintext to confirm.",
    );
  const { file, exported, skipped } = exportSecrets(input.workspaceId, input);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="postbox-vault-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "X-Postbox-Vault-Exported": String(exported),
      "X-Postbox-Vault-Skipped": String(skipped),
    },
  });
});
