import { CliError, EXIT, exitCodeForStatus } from "./errors";

type Fetch = typeof fetch;
export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Return the response text untouched (exports). */
  raw?: boolean;
}

/** Minimal client for the Postbox REST API; it talks to a running server, never the database. */
export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly token?: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message;
      throw new CliError(`Cannot reach ${this.base}: ${reason}`, EXIT.network);
    }
    const text = await response.text();
    if (!response.ok)
      throw new CliError(describeFailure(response.status, text), exitCodeForStatus(response.status));
    if (options.raw) return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError("The server returned a response that is not JSON.", EXIT.server);
    }
  }
}

function describeFailure(status: number, text: string): string {
  let message = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // keep the text
  }
  const hint =
    status === 401
      ? " (set POSTBOX_TOKEN or add a profile with --token)"
      : status === 403
        ? " (the token's role or scope does not allow this)"
        : "";
  return `Server returned ${status}${message ? `: ${message}` : ""}${hint}`;
}
