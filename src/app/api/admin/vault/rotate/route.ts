/**
 * POST /api/admin/vault/rotate { newKey?, prune? } — re-encrypt every secret under the current key. With `newKey`, a
 * new key is generated first (key-file setups only; with POSTBOX_VAULT_KEY, set the new key there and restart).
 * With `prune`, keys no secret uses any more are removed from the key file. Administrators only.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { rotateKeys } from "@/server/vault";
import { VaultCryptoError } from "@/core/vault/crypto";
import { HttpError } from "@/server/errors";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({ newKey: z.boolean().optional(), prune: z.boolean().optional() }).strict(),
  );
  try {
    return json(rotateKeys(input));
  } catch (error) {
    if (error instanceof VaultCryptoError) throw new HttpError(400, error.message);
    throw error;
  }
});
