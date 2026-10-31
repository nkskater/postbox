/**
 * Errors carrying an HTTP status. Kept free of Next.js imports so the
 * repository layer can throw them; route() in http.ts turns them into responses.
 */
const HTTP_ERROR = Symbol.for("postbox.http-error");

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    Object.defineProperty(this, HTTP_ERROR, { value: true });
  }
}

/** Shared queue errors may cross independently loaded Next.js server bundles. */
export function isHttpError(error: unknown): error is HttpError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return (
    candidate[HTTP_ERROR] === true &&
    typeof candidate.message === "string" &&
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 400 &&
    candidate.status <= 599
  );
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
