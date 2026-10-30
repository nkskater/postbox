/**
 * Errors carrying an HTTP status. Kept free of Next.js imports so the
 * repository layer can throw them; route() in http.ts turns them into responses.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
