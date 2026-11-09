/** Talks to a self-hosted Postbox server with a personal API token. No vscode imports. */
import type {
  EnvironmentDoc,
  EnvironmentInfo,
  RequestDef,
  SendContext,
  TreeInfo,
  Variable,
  ViewResult,
  WorkspaceInfo,
} from "./types";

export class PostboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PostboxApiError";
  }
}

export interface ServerOptions {
  baseUrl: string;
  token: string | null;
  fetch?: typeof fetch;
}

/** Normalises what the proxy route returns into a ViewResult. */
export function toViewResult(
  request: Pick<RequestDef, "name" | "method" | "url">,
  raw: {
    response?: {
      status: number;
      statusText: string;
      headers: [string, string][];
      bodyText: string;
      isBinary?: boolean;
      size: number;
      url?: string;
      timings?: { total?: number };
    };
    error?: string;
    tests?: ViewResult["tests"];
    logs?: { level: string; message: string }[];
    warnings?: string[];
    sent?: { url?: string };
  },
): ViewResult {
  const response = raw.response;
  const headers: [string, string][] = (response?.headers ?? []).map(([name, value]) => [
    String(name),
    String(value),
  ]);
  return {
    name: request.name,
    method: request.method,
    url: response?.url ?? raw.sent?.url ?? request.url,
    status: response?.status ?? null,
    statusText: response?.statusText ?? "",
    timeMs: response?.timings?.total ?? null,
    size: response?.size ?? null,
    headers,
    body: response ? (response.isBinary ? `(${response.size} bytes of binary data)` : response.bodyText) : "",
    tests: raw.tests ?? [],
    logs: (raw.logs ?? []).map((entry) => ({ level: entry.level, message: entry.message })),
    error: raw.error ?? null,
    warnings: raw.warnings ?? [],
  };
}

export class ServerBackend {
  private readonly base: string;
  constructor(private readonly options: ServerOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.base))
      throw new Error("The Postbox server URL must start with http:// or https://");
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!response.ok) {
      const message = (parsed as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
      throw new PostboxApiError(
        response.status === 401
          ? "Sign-in required: set an API token with “Postbox: Set API Token”."
          : message,
        response.status,
      );
    }
    return parsed as T;
  }

  workspaces() {
    return this.call<WorkspaceInfo[]>("GET", "/api/workspaces");
  }
  tree(workspaceId: string) {
    return this.call<TreeInfo>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
  }
  getRequest(id: string) {
    return this.call<RequestDef & { folderId: string; workspaceId: string }>(
      "GET",
      `/api/requests/${encodeURIComponent(id)}`,
    );
  }
  saveRequest(id: string, request: Partial<RequestDef>) {
    return this.call<RequestDef>("PATCH", `/api/requests/${encodeURIComponent(id)}`, request);
  }
  environments(workspaceId: string) {
    return this.call<EnvironmentInfo[]>(
      "GET",
      `/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }
  getEnvironment(id: string) {
    return this.call<EnvironmentDoc & { workspaceId: string }>(
      "GET",
      `/api/environments/${encodeURIComponent(id)}`,
    );
  }
  saveEnvironment(id: string, patch: { name?: string; variables?: Variable[] }) {
    return this.call<EnvironmentDoc>("PATCH", `/api/environments/${encodeURIComponent(id)}`, patch);
  }
  createEnvironment(workspaceId: string, name: string, variables: Variable[] = []) {
    return this.call<EnvironmentDoc>("POST", "/api/environments", { workspaceId, name, variables });
  }
  async send(request: RequestDef, context: SendContext, signal?: AbortSignal): Promise<ViewResult> {
    const raw = await this.call<Parameters<typeof toViewResult>[1]>(
      "POST",
      "/api/proxy",
      { ...context, request },
      signal,
    );
    return toViewResult(request, raw);
  }
}
