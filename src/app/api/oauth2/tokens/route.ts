/** GET /api/oauth2/tokens?workspaceId= — saved OAuth 2.0 tokens (metadata only). */
import { json, requireParam, route } from "@/server/http";
import { listSavedTokens } from "@/server/oauth2-tokens";

export const GET = route((req: Request) =>
  json(listSavedTokens(requireParam(new URL(req.url), "workspaceId"))),
);
