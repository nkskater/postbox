/**
 * Turn a RequestDef template (+ inherited folder data) into a PreparedRequest:
 * resolves variables, merges inherited headers, encodes the body and applies auth.
 */
import type { AuthConfig, BodyConfig, FolderDef, KeyValue, PreparedRequest, RequestDef } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { Resolver } from "../variables/resolver";
import { applyAuth, resolveAuth, resolveEffectiveAuth, type OAuth2Token } from "./auth";
import { encodeBody } from "./body";
import type { EngineOptions } from "./engine";

export const USER_AGENT = "Postbox/0.1";

export interface PrepareResult {
  prepared: PreparedRequest;
  unresolved: string[];
  oauth2Token?: OAuth2Token;
  effectiveAuth: AuthConfig;
}

/** Ensure the URL has a scheme; Postman defaults to http:// as well. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function resolveBody(body: BodyConfig, r: Resolver): BodyConfig {
  const kv = (list: KeyValue[]) =>
    list.map((p) => ({ ...p, key: r.resolve(p.key), value: r.resolve(p.value) }));
  switch (body.mode) {
    case "raw":
      return { ...body, raw: r.resolve(body.raw) };
    case "urlencoded":
      return { ...body, urlencoded: kv(body.urlencoded ?? []) };
    case "formdata":
      return {
        ...body,
        formdata: (body.formdata ?? []).map((f) =>
          f.type === "file"
            ? { ...f, key: r.resolve(f.key) }
            : { ...f, key: r.resolve(f.key), value: r.resolve(f.value) },
        ),
      };
    case "graphql":
      return {
        ...body,
        graphql: {
          ...body.graphql,
          query: r.resolve(body.graphql.query),
          variables: r.resolve(body.graphql.variables),
        },
      };
    default:
      return body;
  }
}

/**
 * Merge headers from outermost folder to the request. Later (inner) definitions
 * override earlier ones with the same (case-insensitive) name.
 */
export function mergeHeaders(layers: KeyValue[][], r: Resolver): [string, string][] {
  const map = new Map<string, [string, string]>();
  for (const layer of layers) {
    for (const h of layer ?? []) {
      if (!h.enabled || !h.key?.trim()) continue;
      const key = r.resolve(h.key).trim();
      map.set(key.toLowerCase(), [key, r.resolve(h.value)]);
    }
  }
  return [...map.values()];
}

export async function prepareRequest(
  request: RequestDef,
  ancestors: FolderDef[],
  resolver: Resolver,
  engine?: EngineOptions,
): Promise<PrepareResult> {
  const settings = { ...DEFAULT_SETTINGS, ...request.settings };
  const method = (resolver.resolve(request.method) || "GET").toUpperCase();
  const url = normalizeUrl(resolver.resolve(request.url));

  const headers = mergeHeaders([...ancestors.map((a) => a.headers), request.headers], resolver);
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n);

  const encoded = encodeBody(resolveBody(request.body ?? { mode: "none" }, resolver), method);
  if (encoded.contentType && !has("content-type")) headers.push(["Content-Type", encoded.contentType]);
  if (!has("user-agent")) headers.push(["User-Agent", USER_AGENT]);
  if (!has("accept")) headers.push(["Accept", "*/*"]);
  if (!has("accept-encoding")) headers.push(["Accept-Encoding", "gzip, deflate, br"]);

  const prepared: PreparedRequest = { method, url, headers, body: encoded.body, settings };

  const effectiveAuth = resolveAuth(
    resolveEffectiveAuth([...ancestors.map((a) => a.auth), request.auth]),
    resolver,
  );
  const { oauth2Token } = await applyAuth(prepared, effectiveAuth, engine);

  return { prepared, unresolved: [...resolver.unresolved], oauth2Token, effectiveAuth };
}
