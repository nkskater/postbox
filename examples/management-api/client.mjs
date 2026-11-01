// A small, dependency-free client for the Postbox management API (v1).
// Works in Node 18+ and browsers. See docs/management-api.md and docs/openapi/postbox-management-v1.json.

export class PostboxApiError extends Error {
  constructor(status, message, issues) {
    super(message);
    this.name = "PostboxApiError";
    this.status = status;
    this.issues = issues;
  }
}

export class PostboxClient {
  /**
   * @param {{ baseUrl: string, token?: string, fetch?: typeof fetch }} options
   *   `token` is a personal or service-account token (pbx_…) created in Settings.
   */
  constructor({ baseUrl, token, fetch: fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #send(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    const response = await this.fetch(url, {
      method,
      redirect: "error",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  async #json(method, path, options) {
    const response = await this.#send(method, path, options);
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok)
      throw new PostboxApiError(response.status, data?.error ?? response.statusText, data?.issues);
    return data;
  }

  get = (path, query) => this.#json("GET", path, { query });
  post = (path, body, query) => this.#json("POST", path, { body, query });
  patch = (path, body) => this.#json("PATCH", path, { body });
  put = (path, body) => this.#json("PUT", path, { body });
  delete = (path) => this.#json("DELETE", path);

  workspaces = () => this.get("/api/workspaces");
  createWorkspace = (name) => this.post("/api/workspaces", { name });
  tree = (workspaceId) => this.get(`/api/workspaces/${workspaceId}/tree`);
  createCollection = (workspaceId, name) => this.post("/api/folders", { workspaceId, name });
  environments = (workspaceId) => this.get("/api/environments", { workspaceId });
  setGlobals = (workspaceId, variables) =>
    this.put("/api/variables", { workspaceId, scope: "global", variables });

  /**
   * Run a collection and wait for it to finish. Returns every streamed event; the last is `done`.
   * @param {(event: object) => void} [onEvent] called for each event as it arrives
   */
  async runCollection(input, onEvent) {
    const response = await this.#send("POST", "/api/runs", { body: input });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new PostboxApiError(response.status, data.error ?? response.statusText, data.issues);
    }
    const events = [];
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        events.push(event);
        onEvent?.(event);
      }
    }
    return events;
  }
}

// Example:
//   const client = new PostboxClient({ baseUrl: "http://localhost:3000", token: process.env.POSTBOX_TOKEN });
//   const [workspace] = await client.workspaces();
//   const events = await client.runCollection({ workspaceId: workspace.id, folderId: "…" });
//   console.log(events.at(-1));
