/** POST /api/oauth2/tokens/clear-all — clear every saved token in a workspace (workspace owners). */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { clearAllSavedTokens } from "@/server/oauth2-tokens";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({ workspaceId: z.string(), revoke: z.boolean().default(false) }),
  );
  return json(await clearAllSavedTokens(input.workspaceId, input.revoke));
});
