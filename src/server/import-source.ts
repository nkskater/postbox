/** Shared REST/MCP loading. References never use the server filesystem or ambient credentials. */
import { importSourceSchema, type ImportSource } from "@/core/convert/import-schema";
import {
  bundleOpenApiReferences,
  OPENAPI_LIMITS,
  OpenApiResolutionError,
  type ReferenceDiagnostic,
  type ReferenceSummary,
} from "@/core/convert/openapi-references";
import { importOpenApi, isOpenApi, parseSpec } from "@/core/convert/openapi";
import { sendRequest } from "@/core/http/engine";
import type { HostPolicy } from "@/core/http/policy";
import { DEFAULT_SETTINGS } from "@/core/types";
import { getPolicy } from "./context";
import { importContent, type ImportOutcome } from "./importer";
import * as repo from "./repo";

export interface OpenApiPreview {
  kind: "preview";
  source: "openapi";
  name: string;
  folders: number;
  requests: number;
  variables: number;
  diagnostics: ReferenceDiagnostic[];
  references: ReferenceSummary;
  warnings: string[];
}
export type SourceImportOutcome =
  | ImportOutcome
  | OpenApiPreview
  | {
      kind: "collection";
      source: "openapi";
      id: string;
      name: string;
      folders: number;
      requests: number;
      diagnostics: ReferenceDiagnostic[];
      references: ReferenceSummary;
      warnings: string[];
    };
export async function importSource(
  workspaceId: string,
  raw: ImportSource,
  options: { signal?: AbortSignal; policy?: HostPolicy } = {},
): Promise<SourceImportOutcome> {
  const input = importSourceSchema.parse(raw);
  const signal = AbortSignal.any([
    AbortSignal.timeout(OPENAPI_LIMITS.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const approved = new Set((input.allowedRefOrigins ?? []).map((value) => new URL(value).origin));
  const deadline = Date.now() + OPENAPI_LIMITS.timeoutMs;
  let fetches = 0;
  const fail = (code: string, message: string, target: string, origin?: string): never => {
    throw new OpenApiResolutionError([
      {
        severity: "error",
        code,
        message,
        source: input.sourceUrl ?? input.url ?? "postbox-bundle:///openapi.yaml",
        path: "",
        target,
        ...(origin ? { origin } : {}),
      },
    ]);
  };
  const load = async (address: string, reference: boolean, boundSignal = signal) => {
    let current = new URL(address);
    for (let hop = 0; hop <= 5; hop++) {
      if (!["http:", "https:"].includes(current.protocol) || current.username || current.password)
        fail("invalid-url", "Only HTTP(S) document URLs without credentials are supported", current.href);
      if (reference && !approved.has(current.origin))
        fail(
          "origin-not-approved",
          `Reference origin ${current.origin} is not approved`,
          current.href,
          current.origin,
        );
      if (++fetches > OPENAPI_LIMITS.maxFetches)
        fail(
          "fetch-limit",
          "Document downloads exceed the request limit (including redirects)",
          current.href,
        );
      if (boundSignal.aborted || Date.now() >= deadline)
        fail("time-limit", "Document loading was cancelled or exceeded its time limit", current.href);
      let response;
      try {
        response = await sendRequest(
          {
            method: "GET",
            url: current.href,
            headers: [["Accept", "application/json, application/yaml, application/xml, text/xml, */*"]],
            settings: { ...DEFAULT_SETTINGS, followRedirects: false, useCookieJar: false, timeoutMs: 5000 },
          },
          {
            policy: options.policy ?? getPolicy(),
            signal: boundSignal,
            maxBodyBytes: reference ? OPENAPI_LIMITS.maxDocumentBytes : OPENAPI_LIMITS.maxTotalBytes,
          },
        );
      } catch {
        fail("document-fetch", "Document download failed or was blocked by host policy", current.href);
      }
      if (response!.truncated)
        fail("document-size", "Downloaded document exceeds the byte limit", current.href);
      if ([301, 302, 303, 307, 308].includes(response!.status)) {
        const location = response!.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
        if (!location) fail("redirect-location", "Document redirect has no Location header", current.href);
        if (hop === 5) fail("redirect-limit", "Document download exceeds five redirects", current.href);
        try {
          current = new URL(location!, current);
        } catch {
          fail("invalid-url", "Invalid redirect URL", current.href);
        }
        continue;
      }
      if (response!.status < 200 || response!.status >= 300)
        fail("document-status", `Document download returned HTTP ${response!.status}`, current.href);
      if (response!.isBinary) fail("binary-document", "Expected a text JSON/YAML/XML document", current.href);
      return { content: response!.bodyText, sourceUrl: current.href };
    }
    return fail("redirect-limit", "Too many redirects", current.href);
  };
  const loaded = input.url
    ? await load(input.url, false)
    : { content: input.content ?? "", sourceUrl: input.sourceUrl };
  let openapi = !!input.files;
  if (!openapi && !/^\uFEFF?\s*</.test(loaded.content)) {
    try {
      openapi = isOpenApi(parseSpec(loaded.content));
    } catch {
      /* Legacy importer supplies the format diagnostic. */
    }
  }
  if (!openapi) return importContent(workspaceId, loaded.content, loaded.sourceUrl, input);
  const bundled = await bundleOpenApiReferences({
    ...(input.files ? { files: input.files, entrypoint: input.entrypoint } : { content: loaded.content }),
    sourceUrl: loaded.sourceUrl,
    allowedRefOrigins: input.allowedRefOrigins,
    loadRemote: (uri, refSignal) => load(uri, true, AbortSignal.any([signal, refSignal])),
    signal,
  });
  let converted;
  try {
    converted = importOpenApi(bundled.document, { sourceUrl: bundled.sourceUrl });
  } catch {
    throw new OpenApiResolutionError([
      ...bundled.diagnostics,
      {
        severity: "error",
        code: "conversion-failed",
        source: bundled.sourceUrl ?? input.entrypoint ?? "openapi.yaml",
        path: "",
        message:
          "The resolved document cannot produce request samples. Check reference-only cycles, false schemas and object shapes; no data was imported.",
      },
    ]);
  }
  if (signal.aborted || Date.now() >= deadline)
    fail(
      "time-limit",
      "OpenAPI import was cancelled or exceeded its time limit",
      bundled.sourceUrl ?? "postbox-bundle:///openapi.yaml",
    );
  const metadata = {
    diagnostics: bundled.diagnostics,
    references: bundled.summary,
    warnings: bundled.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message),
  };
  if (input.preview) {
    const count = (node: typeof converted.root): { folders: number; requests: number } =>
      node.children.reduce(
        (total, child) => {
          if (child.kind === "request") total.requests++;
          else {
            const nested = count(child);
            total.folders += nested.folders + 1;
            total.requests += nested.requests;
          }
          return total;
        },
        { folders: 0, requests: 0 },
      );
    return {
      kind: "preview",
      source: "openapi",
      name: converted.root.name,
      ...count(converted.root),
      variables: converted.variables.length,
      ...metadata,
    };
  }
  return {
    kind: "collection",
    source: "openapi",
    ...repo.importTree(workspaceId, converted.root, converted.variables),
    ...metadata,
  };
}
