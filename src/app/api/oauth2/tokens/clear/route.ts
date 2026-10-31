/** POST /api/oauth2/tokens/clear — clear one saved token, optionally revoking it at the provider. */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { clearSavedToken } from "@/server/oauth2-tokens";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      kind: z.enum(["request", "folder"]),
      id: z.string(),
      revoke: z.boolean().default(false),
    }),
  );
  return json(await clearSavedToken(input.workspaceId, input, input.revoke));
});
