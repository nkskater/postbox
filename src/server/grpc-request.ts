/**
 * Shared preparation for the gRPC routes: resolve variables, folder headers and
 * authentication for a request, and collect the secrets to redact from anything returned.
 */
import { z } from "zod";
import type { FolderDef, RequestSettings } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { ProtoError } from "@/core/grpc/proto";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { getPolicy, loadScopes } from "./context";
import { defaultRequest } from "./defaults";
import * as repo from "./repo";

export const grpcRequestSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
});

export async function loadGrpcRequest(input: z.infer<typeof grpcRequestSchema>, signal?: AbortSignal) {
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const resolver = new Resolver(ctx.scopes);
  const r = input.request;
  const settings: RequestSettings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
  const request = defaultRequest({ ...r, method: "POST", settings });
  const { prepared, effectiveAuth, resolvedBody } = await prepareRequest(request, chain, resolver, {
    policy: getPolicy(),
    signal,
  });
  if (prepared.digest || prepared.ntlm || prepared.awsv4)
    throw new ProtoError("This authentication type cannot be used for gRPC");
  const secrets = credentialRedactionValues([...ctx.secrets, ...authCredentialValues(effectiveAuth)]);
  return { settings, prepared, resolvedBody, secrets, baseSecrets: ctx.secrets };
}
