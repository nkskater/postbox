/**
 * Small helpers for route handlers.
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (data: unknown, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);

/** Wrap a handler: converts thrown errors into JSON error responses. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof ZodError) return json({ error: "Invalid input", issues: err.issues }, 400);
      console.error("[postbox] unhandled API error:", (err as Error).message);
      return json({ error: (err as Error).message ?? "Internal error" }, 500);
    }
  };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await req.json();
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
