/**
 * POST /api/graphql/schema — run the standard introspection query against the
 * request's endpoint with its variables, inherited headers and auth applied, and
 * return the introspection data for the editor's schema explorer.
 */
import { z } from "zod";
import type { FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { prepareRequest } from "@/core/http/prepare";
import { sendRequest } from "@/core/http/engine";
import { INTROSPECTION_QUERY, introspectionFailure, schemaFromSource } from "@/core/graphql/schema";
import { Resolver } from "@/core/variables/resolver";
import { getPolicy, loadScopes } from "@/server/context";
import { executionSettings } from "@/server/execution-settings";
import { defaultRequest } from "@/server/defaults";
import { HttpError, json, parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const r = input.request;
  const request = defaultRequest({
    ...r,
    method: "POST",
    body: { mode: "graphql", graphql: { query: INTROSPECTION_QUERY, variables: "" } },
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
  });
  const engine = { policy: getPolicy(), oauth2CacheScope: input.workspaceId, signal: req.signal };
  const { prepared } = await prepareRequest(request, chain, new Resolver(ctx.scopes), engine, {
    defaults: executionSettings().requestDefaults,
  });
  let res;
  try {
    res = await sendRequest(prepared, { ...engine, maxBodyBytes: 20 * 1024 * 1024 });
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    // Reported below.
  }
  const data = (parsed as { data?: { __schema?: unknown } } | null)?.data;
  if (res.status >= 400 || !data?.__schema)
    throw new HttpError(502, introspectionFailure(res.status, res.bodyText));
  try {
    // Reject malformed results here rather than in every browser.
    schemaFromSource(data);
  } catch (err) {
    throw new HttpError(502, `Introspection result is not a valid schema: ${(err as Error).message}`);
  }
  return json({ introspection: data, fetchedAt: Date.now() });
});
