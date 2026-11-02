/**
 * POST /api/codegen — generate a code snippet for the request in the editor,
 * applying inherited headers/auth and (optionally) resolving variables.
 */
import { z } from "zod";
import { DEFAULT_SETTINGS } from "@/core/types";
import { generateCodeSnippet, codegenAuthWarnings, CodegenInputError } from "@/core/convert/codegen-extended";
import { codegenLanguageSchema, codegenOptionsSchema } from "@/core/convert/codegen-schema";
import { CODEGEN_LANGUAGES } from "@/core/convert/codegen-targets";
import { HttpError } from "@/server/errors";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import { defaultRequest } from "@/server/defaults";
import * as repo from "@/server/repo";
import { loadScopes } from "@/server/context";
import { json, parseBody, route } from "@/server/http";
import { requestInputSchema } from "@/core/schemas";
import { executionSettings } from "@/server/execution-settings";

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
      request: requestInputSchema,
      language: codegenLanguageSchema,
      options: codegenOptionsSchema,
      resolveVariables: z.boolean().default(true),
    }),
  );
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  const chain = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const request = defaultRequest({
    ...input.request,
    settings: { ...DEFAULT_SETTINGS, ...(input.request.settings ?? {}) },
  });
  // Vault references stay as {{vault:name}} in a snippet: decrypted values never leave an execution.
  const resolver = input.resolveVariables
    ? new Resolver(
        (({ vault: _vault, vaultScripts: _names, ...scopes }) => scopes)(
          loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null).scopes,
        ),
      )
    : new PassthroughResolver();
  const { prepared, resolvedBody, effectiveAuth } = await prepareRequest(
    request,
    chain,
    resolver,
    undefined,
    {
      offline: true,
      defaults: executionSettings().requestDefaults,
    },
  );
  try {
    const result = await generateCodeSnippet(
      input.language,
      {
        method: prepared.method,
        url: prepared.url,
        headers: prepared.headers,
        body: resolvedBody,
        bodyBytes: prepared.body,
        socketPath: prepared.settings.socketPath,
      },
      input.options,
    );
    return json({ ...result, warnings: [...result.warnings, ...codegenAuthWarnings(effectiveAuth)] });
  } catch (error) {
    if (error instanceof CodegenInputError) throw new HttpError(400, error.message);
    throw error;
  }
});

/** Discover supported targets and their language-specific settings. */
export const GET = route(async () => json({ targets: CODEGEN_LANGUAGES }));
