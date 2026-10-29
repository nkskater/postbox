/**
 * POST /api/codegen — generate a code snippet for the request in the editor,
 * applying inherited headers/auth and (optionally) resolving variables.
 */
import { z } from "zod";
import type { RequestDef } from "@/core/types";
import { generateSnippet, type CodegenLanguage } from "@/core/convert/codegen";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import { defaultRequest } from "@/server/defaults";
import * as repo from "@/server/repo";
import { loadScopes } from "@/server/context";
import { json, parseBody, route } from "@/server/http";

/** Resolver that leaves every {{variable}} untouched. */
class PassthroughResolver extends Resolver {
  constructor() {
    super(emptyScopes());
  }
  override resolve(input: string | undefined): string {
    return input ?? "";
  }
}

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      environmentId: z.string().nullish(),
      folderId: z.string().nullish(),
      request: z.record(z.string(), z.unknown()),
      language: z.enum(["curl", "fetch", "python", "powershell"]),
      resolveVariables: z.boolean().default(true),
    }),
  );
  const chain = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const request = defaultRequest(input.request as Partial<RequestDef>);
  const resolver = input.resolveVariables
    ? new Resolver(loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null).scopes)
    : new PassthroughResolver();
  const { prepared, resolvedBody } = await prepareRequest(request, chain, resolver, undefined, {
    offline: true,
  });
  const code = generateSnippet(input.language as CodegenLanguage, {
    method: prepared.method,
    url: prepared.url,
    headers: prepared.headers,
    body: resolvedBody,
  });
  return json({ code });
});
