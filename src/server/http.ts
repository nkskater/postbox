/**
 * Small helpers for route handlers.
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { API_VERSION, API_VERSION_HEADER } from "@/core/management-api/openapi";
import { HttpError, isHttpError } from "./errors";
import { callerOf } from "./caller";
import { withCaller } from "./access-context";
import { authorizeRest, restPolicy } from "./access-policy";
import { auditDenied, auditedCall, shouldAudit } from "./audit";
import { pruneAuditIfDue } from "./audit-settings";

export { HttpError, notFound } from "./errors";

export const json = (data: unknown, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

/** Tell clients which management API version answered (see docs/management-api.md). */
export function withApiVersion<T extends Response>(response: T): T {
  try {
    response.headers.set(API_VERSION_HEADER, String(API_VERSION));
  } catch {
    // Immutable headers (a passed-through fetch response) cannot be annotated.
  }
  return response;
}

/** Wrap a handler: converts thrown errors into JSON error responses. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  const handle = async (...args: A): Promise<Response> => {
    try {
      const req = args[0];
      if (!(req instanceof Request)) return await fn(...args);
      const policy = restPolicy(req.method, new URL(req.url).pathname);
      if (policy?.source === "public") return await fn(...args);
      const caller = callerOf(req);
      if (!caller) throw new HttpError(401, "Authentication required");
      const audited = shouldAudit(req.method, policy, new URL(req.url).pathname);
      if (audited) pruneAuditIfDue();
      try {
        await authorizeRest(caller, req, async () => {
          try {
            const value = JSON.parse(await readBodyText(req.clone()));
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new HttpError(400, "Body must be a JSON object");
            return value;
          } catch (error) {
            if (isHttpError(error)) {
              void req.body?.cancel().catch(() => undefined);
              throw error;
            }
            throw new HttpError(400, "Body must be valid JSON");
          }
        });
      } catch (err) {
        if (audited && policy && isHttpError(err) && err.status === 403)
          withCaller(caller, () => auditDenied(req, policy, err.message));
        throw err;
      }
      return await withCaller(caller, () =>
        audited && policy ? auditedCall(req, policy, () => fn(...args)) : fn(...args),
      );
    } catch (err) {
      if (isHttpError(err)) return json({ error: err.message }, err.status);
      if (err instanceof ZodError) return json({ error: "Invalid input", issues: err.issues }, 400);
      console.error("[postbox] unhandled API error:", err);
      return json({ error: "Internal error" }, 500);
    }
  };
  return async (...args: A): Promise<Response> => withApiVersion(await handle(...args));
}

/** Largest JSON body the API accepts (API_BODY_LIMIT_MB, default 25 MB; uploads travel inline as base64). */
export const bodyLimitBytes = () => (Number(process.env.API_BODY_LIMIT_MB) || 25) * 1024 * 1024;

/** Read a request body as text, failing with 413 as soon as it exceeds `limit` bytes. */
export async function readBodyText(req: Request, limit = bodyLimitBytes()): Promise<string> {
  const tooLarge = () => new HttpError(413, `Request body exceeds ${Math.round(limit / 1048576)} MB`);
  if (Number(req.headers.get("content-length")) > limit) throw tooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const text = await readBodyText(req);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return schema.parse(data);
}

export function requireParam(url: URL | string, name: string): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const v = u.searchParams.get(name);
  if (!v) throw new HttpError(400, `Missing query parameter "${name}"`);
  return v;
}
