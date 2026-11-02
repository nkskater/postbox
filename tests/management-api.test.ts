import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ZodType } from "zod";
import { API_VERSION, API_VERSION_HEADER, buildOpenApi, SPEC_VERSION } from "@/core/management-api/openapi";
import { OPERATIONS, policyKey, type Operation } from "@/core/management-api/operations";
import { errorSchema } from "@/core/management-api/schemas";
import type { UserRow } from "@/server/db/schema";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mgmt-api-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const hooks = await import("@/server/webhooks");
const { REST_POLICIES } = await import("@/server/access-policy");
const handlers = import.meta.glob<Record<string, (...args: unknown[]) => Promise<Response>>>(
  "/src/app/api/**/route.ts",
);

const byId = new Map(OPERATIONS.map((operation) => [operation.id, operation]));
const document = buildOpenApi() as {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown> };
};

// ------------------------------------------------------------------ the document

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with a stable operation id for every route", () => {
    expect(document.info.version).toBe(SPEC_VERSION);
    const ids = OPERATIONS.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);
    const documented = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    expect(documented.sort()).toEqual([...ids].sort());
  });

  it("resolves every $ref", () => {
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(20);
    for (const [, name] of refs) expect(document.components.schemas[name], name).toBeDefined();
    expect(JSON.stringify(document)).not.toContain("#/$defs");
  });

  it("matches the checked-in file (run `npm run openapi:generate` after changing the contract)", () => {
    const file = path.join(process.cwd(), "docs", "openapi", "postbox-management-v1.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(document);
  });

  it("has a request example the schema accepts for every operation that declares one", () => {
    for (const operation of OPERATIONS.filter((candidate) => candidate.example !== undefined))
      expect(operation.body!.safeParse(operation.example).success, operation.id).toBe(true);
  });
});

describe("contract and access policy", () => {
  it("documents only routes that exist, with the permission the policy enforces", () => {
    for (const operation of OPERATIONS) {
      const policy = REST_POLICIES[policyKey(operation)];
      expect(policy, `${policyKey(operation)} has no access policy`).toBeDefined();
      if (["public", "account", "admin"].includes(operation.access))
        expect(
          policy.source === "list" || policy.source === "create" ? "account" : policy.source,
          operation.id,
        ).toBe(operation.access);
      else expect(policy.action, operation.id).toBe(operation.access);
    }
  });

  it("accounts for every other route, so new route families must be classified on purpose", () => {
    // Routes outside v1 are internal to the web app or planned for later versions of the contract.
    const outside = [
      "/api/auth/",
      "/api/admin/",
      "/api/me",
      "/api/invites",
      "/api/backup",
      "/api/documentation/",
      "/api/catalog",
      "/api/proxy",
      "/api/oauth2/",
      "/api/ws",
      "/api/socketio",
      "/api/grpc",
      "/api/mqtt",
      "/api/graphql/",
      "/api/sse",
      "/api/codegen",
      "/api/mocks",
      "/api/script-packages",
      "/api/datasets",
      "/api/import",
      "/api/tree/move",
      "/api/export/",
      "/api/runs/[id]/export",
      "/api/history",
      "/api/cookies",
      "/api/mcp",
      "/api/hook-listeners",
      "/api/load-runs",
      "/api/settings/import",
      "/api/workspaces/[id]/members",
      "/api/workspaces/[id]/usage",
      "/api/workspaces/[id]/audit",
      "/api/requests/[id]/examples",
      "/api/requests/[id]/contract-validation",
      "/api/folders/[id]/documentation",
      "/api/folders/[id]/catalog",
    ];
    const documented = new Set(OPERATIONS.map(policyKey));
    const unclassified = Object.keys(REST_POLICIES).filter((key) => {
      const route = key.split(" ")[1];
      return !documented.has(key) && !outside.some((prefix) => route.startsWith(prefix));
    });
    expect(unclassified).toEqual([]);
  });
});

// ------------------------------------------------------------------ the running API

let owner: UserRow;
let local: TestServer;
const keys: Record<string, string> = {};
const covered = new Set<string>();

interface CallInput {
  id?: string;
  query?: Record<string, string>;
  body?: unknown;
  key?: string | null;
  status?: number;
}

/** Call a real route handler the way an HTTP client would, and check status + schema from the contract. */
async function call(
  operationId: string,
  input: CallInput = {},
): Promise<{ response: Response; data: unknown }> {
  const operation = byId.get(operationId) as Operation;
  const route = `/src/app${operation.path.replace("{id}", "[id]")}/route.ts`;
  const mod = await handlers[route]();
  const url = new URL(
    `http://localhost${operation.path.replace("{id}", encodeURIComponent(input.id ?? ""))}`,
  );
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);
  const key = input.key === undefined ? keys.owner : input.key;
  const response = await mod[operation.method](
    new Request(url, {
      method: operation.method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
    { params: Promise.resolve({ id: input.id ?? "" }) },
  );
  const expected = input.status ?? operation.status;
  const streaming = operation.contentType && expected === operation.status;
  const text = await response.text();
  expect(response.status, `${operationId}: ${text.slice(0, 300)}`).toBe(expected);
  expect(response.headers.get(API_VERSION_HEADER), operationId).toBe(String(API_VERSION));
  const data = streaming ? text : text ? JSON.parse(text) : undefined;
  let schema: ZodType | undefined;
  if (expected === operation.status) {
    if (streaming) expect(response.headers.get("content-type")).toContain(operation.contentType);
    schema = operation.response;
    covered.add(operationId);
  } else schema = errorSchema;
  if (schema) {
    const parsed = schema.safeParse(data);
    expect(
      parsed.success,
      `${operationId}: ${JSON.stringify(parsed.error?.issues)} in ${text.slice(0, 300)}`,
    ).toBe(true);
  }
  return { response, data };
}

/** A fetch that dispatches to the real route handlers, for exercising the example client. */
const handlerFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const pathname = new URL(request.url).pathname;
  for (const [file, load] of Object.entries(handlers)) {
    const pattern = file.replace("/src/app", "").replace("/route.ts", "").replaceAll("[id]", "([^/]+)");
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (!match) continue;
    const mod = await load();
    return mod[request.method](request, { params: Promise.resolve({ id: match[1] ?? "" }) });
  }
  return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
};

describe("management API conformance", () => {
  beforeAll(async () => {
    hooks.setWebhookWorkerManual(true);
    local = await startTestServer();
    owner = await users.createUser({ username: "owner", password: "password123" });
    keys.owner = users.createToken(owner.id, "full").token;
    keys.read = users.createToken(owner.id, "ro", null, { scope: "read" }).token;
  });
  afterAll(async () => {
    await local.close();
    hooks.setWebhookWorkerManual(false);
  });

  it("serves its own document and version header without credentials", async () => {
    const { data } = await call("getOpenApi", { key: null });
    expect(data).toEqual(document);
    await call("getHealth", { key: null });
  });

  it("round-trips workspaces, collections, requests, environments, runs, schedules, webhooks and settings", async () => {
    const workspace = (await call("createWorkspace", { body: byId.get("createWorkspace")!.example }))
      .data as { id: string };
    await call("listWorkspaces");
    await call("renameWorkspace", { id: workspace.id, body: byId.get("renameWorkspace")!.example });

    const collection = (await call("createFolder", { body: { workspaceId: workspace.id, name: "Orders" } }))
      .data as {
      id: string;
    };
    const folder = (
      await call("createFolder", {
        body: { workspaceId: workspace.id, parentId: collection.id, name: "Smoke" },
      })
    ).data as { id: string };
    await call("getFolder", { id: collection.id });
    await call("updateFolder", {
      id: folder.id,
      body: {
        name: "Smoke tests",
        description: "Checks after deploys",
        testScript: "pm.test('ok', () => {});",
      },
    });
    const copy = (await call("duplicateFolder", { id: folder.id })).data as { id: string };
    await call("deleteFolder", { id: copy.id });

    const request = (
      await call("createRequest", {
        body: {
          workspaceId: workspace.id,
          folderId: folder.id,
          request: { name: "Echo", method: "GET", url: `${local.url}/echo` },
        },
      })
    ).data as { id: string };
    await call("getRequest", { id: request.id });
    await call("updateRequest", { id: request.id, body: { name: "Echo (updated)" } });
    const requestCopy = (await call("duplicateRequest", { id: request.id })).data as { id: string };
    await call("deleteRequest", { id: requestCopy.id });
    const tree = (await call("getWorkspaceTree", { id: workspace.id })).data as {
      requests: { id: string }[];
    };
    expect(tree.requests.map((entry) => entry.id)).toContain(request.id);

    const environment = (
      await call("createEnvironment", {
        body: { ...(byId.get("createEnvironment")!.example as object), workspaceId: workspace.id },
      })
    ).data as { id: string };
    await call("listEnvironments", { query: { workspaceId: workspace.id } });
    await call("getEnvironment", { id: environment.id });
    await call("updateEnvironment", {
      id: environment.id,
      body: {
        name: "staging-eu",
        variables: [{ key: "region", value: "eu", type: "default", enabled: true }],
      },
    });
    await call("replaceVariables", {
      body: { ...(byId.get("replaceVariables")!.example as object), workspaceId: workspace.id },
    });
    const globals = (await call("listVariables", { query: { workspaceId: workspace.id, scope: "global" } }))
      .data as {
      key: string;
    }[];
    expect(globals.map((variable) => variable.key)).toEqual(["token"]);

    const streamed = (
      await call("startRun", {
        body: {
          workspaceId: workspace.id,
          folderId: collection.id,
          environmentId: environment.id,
          options: { iterations: 1 },
        },
      })
    ).data as string;
    const events = streamed
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.at(-1)?.type).toBe("done");
    const runs = (await call("listRuns", { query: { workspaceId: workspace.id, folderId: collection.id } }))
      .data as {
      id: string;
    }[];
    expect(runs).toHaveLength(1);
    await call("getRun", { id: runs[0].id });
    expect(((await call("cancelRun", { id: runs[0].id })).data as { cancelled: boolean }).cancelled).toBe(
      false,
    );
    await call("deleteRun", { id: runs[0].id });

    const schedule = (
      await call("createSchedule", {
        body: {
          workspaceId: workspace.id,
          folderId: collection.id,
          name: "Nightly",
          cron: "0 3 * * *",
          enabled: false,
        },
      })
    ).data as { id: string };
    await call("listSchedules", { query: { workspaceId: workspace.id } });
    await call("updateSchedule", { id: schedule.id, body: { name: "Nightly smoke", cron: "30 3 * * *" } });
    await call("runSchedule", { id: schedule.id });
    await call("deleteSchedule", { id: schedule.id });

    const hook = (
      await call("createWebhook", {
        body: { workspaceId: workspace.id, name: "CI", url: `${local.url}/echo`, events: ["run.failed"] },
      })
    ).data as { id: string };
    const listed = (await call("listWebhooks", { query: { workspaceId: workspace.id } })).data as object[];
    expect(JSON.stringify(listed)).not.toContain("secret");
    await call("getWebhook", { id: hook.id });
    await call("updateWebhook", { id: hook.id, body: { events: ["run.failed", "run.error"] } });
    await call("rotateWebhookSecret", { id: hook.id });
    await call("testWebhook", { id: hook.id });
    await hooks.processDue(Date.now());
    const deliveries = (await call("listWebhookDeliveries", { id: hook.id, query: { limit: "10" } }))
      .data as {
      id: string;
    }[];
    expect(deliveries).toHaveLength(1);
    await call("replayWebhookDelivery", { id: hook.id, body: { deliveryId: deliveries[0].id } });
    await call("deleteWebhook", { id: hook.id });

    await call("getSettings");
    await call("updateSettings", { body: { values: { "appearance.theme": "dark" } } });

    const environmentCopy = (await call("duplicateEnvironment", { id: environment.id })).data as {
      id: string;
    };
    await call("deleteEnvironment", { id: environmentCopy.id });
    await call("deleteEnvironment", { id: environment.id });
    await call("deleteFolder", { id: collection.id });
    await call("deleteWorkspace", { id: workspace.id });
  });

  it("exercised every documented operation", () => {
    expect(OPERATIONS.map((operation) => operation.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it("reports errors in the documented envelope", async () => {
    const workspace = (await call("createWorkspace", { body: { name: "Errors" } })).data as { id: string };
    const bad = await call("createFolder", { body: { workspaceId: workspace.id, name: "" }, status: 400 });
    expect((bad.data as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    await call("getFolder", { id: "missing", status: 404 });
    await call("listEnvironments", { query: { workspaceId: workspace.id }, key: null, status: 401 });
  });

  it("enforces the documented key scope", async () => {
    const workspace = (await call("createWorkspace", { body: { name: "Scopes" } })).data as { id: string };
    const query = { workspaceId: workspace.id };
    await call("listEnvironments", { query, key: keys.read });
    await call("createEnvironment", {
      body: { workspaceId: workspace.id, name: "nope" },
      key: keys.read,
      status: 403,
    });
    await call("listWebhooks", { query, key: keys.read, status: 403 });
    await call("startRun", {
      body: { workspaceId: workspace.id, folderId: "x" },
      key: keys.read,
      status: 403,
    });
  });

  it("works through the example client", async () => {
    const { PostboxClient, PostboxApiError } = await import("../examples/management-api/client.mjs");
    const client = new PostboxClient({ baseUrl: "http://localhost", token: keys.owner, fetch: handlerFetch });
    const workspace = await client.createWorkspace("Client example");
    const collection = await client.createCollection(workspace.id, "Health");
    await client.post("/api/requests", {
      workspaceId: workspace.id,
      folderId: collection.id,
      request: { name: "Echo", method: "GET", url: `${local.url}/echo` },
    });
    await client.setGlobals(workspace.id, [{ key: "a", value: "1", type: "default", enabled: true }]);
    expect((await client.tree(workspace.id)).requests).toHaveLength(1);
    const seen: string[] = [];
    const events = await client.runCollection(
      { workspaceId: workspace.id, folderId: collection.id },
      (event: object) => seen.push((event as { type: string }).type),
    );
    expect(events.at(-1).type).toBe("done");
    expect(seen).toEqual(events.map((event: { type: string }) => event.type));
    const failure = await client.get("/api/folders/missing").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostboxApiError);
    expect(failure.status).toBe(404);
    const rejected = await client.runCollection({ workspaceId: workspace.id, folderId: "nope" }).then(
      () => ({ status: 0 }),
      (error: { status: number }) => error,
    );
    expect(rejected.status).toBe(404);
  });
});
