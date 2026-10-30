/**
 * Model Context Protocol (MCP) server for Postbox.
 *
 * Exposes workspaces, collections/folders, requests, environments, variables,
 * single-request execution, collection runs, code generation, and import/export
 * as MCP tools and resources over `/api/mcp`.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DataTable, FolderDef, KeyValue, RequestDef, RequestSettings, Variable } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { parseCurl } from "@/core/convert/curl";
import { generateSnippet, type CodegenLanguage } from "@/core/convert/codegen";
import { exportPostmanCollection, exportPostmanEnvironment } from "@/core/convert/postman";
import { prepareRequest } from "@/core/http/prepare";
import { sendRequest } from "@/core/http/engine";
import { DataValidationError, formatIssue, parseJsonData, readCsv } from "@/core/runner/data";
import { renderReport, type ReportFormat } from "@/core/runner/reporters";
import { authSchema, bodySchema, keyValueSchema, settingsPatchSchema, variableSchema } from "@/core/schemas";
import { Resolver } from "@/core/variables/resolver";
import { getPolicy, loadScopes, runSingleRequest } from "./context";
import { defaultRequest } from "./defaults";
import { importContent } from "./importer";
import * as repo from "./repo";
import { currentCaller } from "./access-context";
import { describeCaller } from "./caller";
import { workspaceRole } from "./authorize";
import * as runs from "./runs";
import { executionSettings } from "./execution-settings";

const SECRET_MASK = "••••••••";

// ------------------------------------------------------------------ helpers

function okJson(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          err instanceof DataValidationError ? { error: message, issues: err.issues } : { error: message },
        ),
      },
    ],
  };
}

function resolveWorkspaceId(workspaceId?: string | null): string {
  if (workspaceId) {
    const ws = repo.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    return ws.id;
  }
  const list = repo.ensureDefaultWorkspace();
  return list[0].id;
}

function maskVariables(vars: Variable[], includeSecrets = false): Variable[] {
  if (includeSecrets) return vars;
  return vars.map((v) => (v.type === "secret" && v.value ? { ...v, value: SECRET_MASK } : v));
}

// ------------------------------------------------------------------ schemas

const variableInputSchema = variableSchema.extend({ key: z.string().min(1) });

// ------------------------------------------------------------------ server factory

export function createPostboxMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "postbox",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // ================================================================ RESOURCES

  server.registerResource(
    "workspaces",
    "postbox://workspaces",
    {
      title: "Postbox Workspaces",
      description: "List of all workspaces in Postbox with collection and environment summaries",
      mimeType: "application/json",
    },
    async (uri) => {
      const list = repo.ensureDefaultWorkspace().map((ws) => {
        const tree = repo.getTreeSummary(ws.id);
        const envs = repo.listEnvironments(ws.id);
        return {
          ...ws,
          collections: tree.folders.filter((f) => f.parentId === null).length,
          folders: tree.folders.length,
          requests: tree.requests.length,
          environments: envs.map((e) => ({ id: e.id, name: e.name })),
        };
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(list, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "workspace_tree",
    new ResourceTemplate("postbox://workspaces/{workspaceId}/tree", {
      list: async () => ({
        resources: repo.ensureDefaultWorkspace().map((ws) => ({
          uri: `postbox://workspaces/${ws.id}/tree`,
          name: `${ws.name} – Tree`,
          description: `Collections, folders, requests, and environments in workspace "${ws.name}"`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Workspace Collection Tree",
      description: "Folders, requests, and environments inside a workspace",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const workspaceId = String(vars.workspaceId);
      const ws = repo.getWorkspace(workspaceId);
      if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
      const summary = repo.getTreeSummary(workspaceId);
      const environments = repo.listEnvironments(workspaceId).map((e) => ({ id: e.id, name: e.name }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ workspace: ws, ...summary, environments }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "folder",
    new ResourceTemplate("postbox://folders/{folderId}", { list: undefined }),
    {
      title: "Collection or Folder",
      description: "Full collection/folder definition and nested tree",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const folderId = String(vars.folderId);
      const folder = repo.getFolder(folderId);
      if (!folder) throw new Error(`Folder not found: ${folderId}`);
      const tree = repo.getFolderTree(folderId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ folder, tree }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "request",
    new ResourceTemplate("postbox://requests/{requestId}", { list: undefined }),
    {
      title: "Saved Request",
      description: "Full request definition (method, URL, params, headers, body, auth, scripts, settings)",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const requestId = String(vars.requestId);
      const req = repo.getRequest(requestId);
      if (!req) throw new Error(`Request not found: ${requestId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(req, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "environment",
    new ResourceTemplate("postbox://environments/{environmentId}", { list: undefined }),
    {
      title: "Environment",
      description: "Environment definition and variables (secrets masked)",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const environmentId = String(vars.environmentId);
      const env = repo.getEnvironment(environmentId);
      if (!env) throw new Error(`Environment not found: ${environmentId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...env, variables: maskVariables(env.variables, false) }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Current identity",
      description: "The authenticated caller and their accessible workspace roles.",
      inputSchema: {},
    },
    async () =>
      okJson({
        ...describeCaller(currentCaller() ?? null),
        workspaces: repo.listWorkspaces().map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          role: workspaceRole(currentCaller(), workspace.id),
        })),
      }),
  );

  // ================================================================ WORKSPACES

  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List all workspaces in Postbox (creates the default workspace on first launch).",
      inputSchema: {},
    },
    async () => {
      try {
        const workspaces = repo.ensureDefaultWorkspace().map((ws) => {
          const tree = repo.getTreeSummary(ws.id);
          const envs = repo.listEnvironments(ws.id);
          return {
            ...ws,
            collectionsCount: tree.folders.filter((f) => f.parentId === null).length,
            foldersCount: tree.folders.length,
            requestsCount: tree.requests.length,
            environmentsCount: envs.length,
          };
        });
        return okJson({ workspaces });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create Workspace",
      description: "Create a new workspace.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Workspace name"),
      },
    },
    async ({ name }) => {
      try {
        return okJson(repo.createWorkspace(name));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "rename_workspace",
    {
      title: "Rename Workspace",
      description: "Rename an existing workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID"),
        name: z.string().min(1).max(200).describe("New workspace name"),
      },
    },
    async ({ workspaceId, name }) => {
      try {
        const ws = repo.getWorkspace(workspaceId);
        if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
        repo.renameWorkspace(workspaceId, name);
        return okJson(repo.getWorkspace(workspaceId));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "delete_workspace",
    {
      title: "Delete Workspace",
      description: "Delete a workspace and all its collections, requests, and environments.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID to delete"),
      },
    },
    async ({ workspaceId }) => {
      try {
        const ws = repo.getWorkspace(workspaceId);
        if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
        repo.deleteWorkspace(workspaceId);
        repo.ensureDefaultWorkspace();
        return okJson({ deleted: true, workspaceId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_workspace_tree",
    {
      title: "Get Workspace Tree",
      description:
        "List all collections, folders, requests, and environments in a workspace. Omit workspaceId to use the default workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
      },
    },
    async ({ workspaceId }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        const ws = repo.getWorkspace(wsId)!;
        const { folders, requests } = repo.getTreeSummary(wsId);
        const environments = repo.listEnvironments(wsId).map((e) => ({ id: e.id, name: e.name }));
        return okJson({
          workspace: ws,
          folders,
          requests,
          environments,
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ FOLDERS / COLLECTIONS

  server.registerTool(
    "get_folder",
    {
      title: "Get Folder or Collection",
      description:
        "Get a collection or folder definition (auth, headers, pre-request/test scripts) and optionally its full nested tree.",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID"),
        includeTree: z.boolean().default(true).describe("Include nested folders and requests"),
      },
    },
    async ({ folderId, includeTree }) => {
      try {
        const folder = repo.getFolder(folderId);
        if (!folder) throw new Error(`Folder not found: ${folderId}`);
        const chain = repo.getFolderChain(folderId);
        const collectionId = chain[0]?.id ?? folderId;
        const collectionVariables = maskVariables(
          repo.listVariables(folder.workspaceId, "collection", collectionId),
          false,
        );
        const tree = includeTree ? repo.getFolderTree(folderId) : undefined;
        return okJson({ folder, collectionVariables, tree });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create Collection or Folder",
      description:
        "Create a top-level collection (when parentId is omitted/null) or a sub-folder inside an existing collection/folder.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe("Parent folder/collection ID, or null/omitted to create a root collection"),
        name: z.string().min(1).max(300).describe("Collection or folder name"),
        description: z.string().optional(),
        auth: authSchema.optional(),
        headers: z.array(keyValueSchema).optional(),
        preRequestScript: z.string().optional(),
        testScript: z.string().optional(),
      },
    },
    async ({ workspaceId, parentId, name, description, auth, headers, preRequestScript, testScript }) => {
      try {
        let wsId: string;
        if (parentId) {
          const parent = repo.getFolder(parentId);
          if (!parent) throw new Error(`Parent folder not found: ${parentId}`);
          wsId = parent.workspaceId;
        } else {
          wsId = resolveWorkspaceId(workspaceId);
        }
        const partial: Partial<FolderDef> = { name };
        if (description !== undefined) partial.description = description;
        if (auth !== undefined) partial.auth = auth;
        if (headers !== undefined) partial.headers = headers;
        if (preRequestScript !== undefined) partial.preRequestScript = preRequestScript;
        if (testScript !== undefined) partial.testScript = testScript;
        const created = repo.createFolder(wsId, parentId ?? null, partial);
        return okJson(created);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "update_folder",
    {
      title: "Update Collection or Folder",
      description: "Update a collection or folder's name, description, auth, headers, or scripts.",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID"),
        name: z.string().min(1).max(300).optional(),
        description: z.string().optional(),
        auth: authSchema.optional(),
        headers: z.array(keyValueSchema).optional(),
        preRequestScript: z.string().optional(),
        testScript: z.string().optional(),
      },
    },
    async ({ folderId, ...patch }) => {
      try {
        const existing = repo.getFolder(folderId);
        if (!existing) throw new Error(`Folder not found: ${folderId}`);
        const cleanPatch = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        ) as Partial<FolderDef>;
        const updated = repo.updateFolder(folderId, cleanPatch);
        return okJson(updated);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete Collection or Folder",
      description: "Delete a collection or folder and all nested folders and requests.",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID to delete"),
      },
    },
    async ({ folderId }) => {
      try {
        const existing = repo.getFolder(folderId);
        if (!existing) throw new Error(`Folder not found: ${folderId}`);
        repo.deleteFolder(folderId);
        return okJson({ deleted: true, folderId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "duplicate_folder",
    {
      title: "Duplicate Collection or Folder",
      description:
        "Recursively duplicate a collection or folder (including requests and collection variables).",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID to duplicate"),
      },
    },
    async ({ folderId }) => {
      try {
        const copy = repo.duplicateFolder(folderId);
        if (!copy) throw new Error(`Folder not found: ${folderId}`);
        return okJson(copy);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ REQUESTS

  server.registerTool(
    "get_request",
    {
      title: "Get Request",
      description:
        "Get the full definition of a saved HTTP request (method, URL, params, headers, body, auth, scripts, settings, examples).",
      inputSchema: {
        requestId: z.string().min(1).describe("Saved request ID"),
      },
    },
    async ({ requestId }) => {
      try {
        const req = repo.getRequest(requestId);
        if (!req) throw new Error(`Request not found: ${requestId}`);
        const chain = repo.getFolderChain(req.folderId);
        return okJson({
          request: req,
          folderPath: chain.map((f) => ({ id: f.id, name: f.name })),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "create_request",
    {
      title: "Create Request",
      description:
        "Create a new saved HTTP request inside a collection or folder. You can pass structured fields or a `curl` command string.",
      inputSchema: {
        folderId: z.string().min(1).describe("Parent collection or folder ID"),
        name: z.string().min(1).max(300).optional().describe("Request name"),
        curl: z
          .string()
          .optional()
          .describe("Optional cURL command to parse into method, URL, headers, body, and auth"),
        method: z.string().optional().describe("HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)"),
        url: z.string().optional().describe("Request URL (may contain {{variables}})"),
        params: z.array(keyValueSchema).optional().describe("Query parameters"),
        headers: z.array(keyValueSchema).optional().describe("HTTP headers"),
        body: bodySchema.optional().describe("Request body configuration"),
        auth: authSchema.optional().describe("Authentication configuration"),
        preRequestScript: z.string().optional().describe("JavaScript pre-request script (pm.* API)"),
        testScript: z.string().optional().describe("JavaScript post-response test script (pm.* API)"),
        settings: settingsPatchSchema.optional().describe("Per-request HTTP engine settings"),
        description: z.string().optional(),
      },
    },
    async ({
      folderId,
      name,
      curl,
      method,
      url,
      params,
      headers,
      body,
      auth,
      preRequestScript,
      testScript,
      settings,
      description,
    }) => {
      try {
        const folder = repo.getFolder(folderId);
        if (!folder) throw new Error(`Folder not found: ${folderId}`);

        const partial: Partial<RequestDef> = {};
        if (curl) {
          const parsed = parseCurl(curl);
          partial.method = parsed.method;
          partial.url = parsed.url;
          partial.headers = parsed.headers;
          partial.body = parsed.body;
          partial.auth = parsed.auth;
          partial.settings = {
            ...DEFAULT_SETTINGS,
            verifySsl: !parsed.insecure,
            followRedirects: parsed.followRedirects,
          };
        }
        if (name !== undefined) partial.name = name;
        else if (partial.url && !partial.name) partial.name = `${partial.method ?? "GET"} ${partial.url}`;
        if (method !== undefined) partial.method = method.toUpperCase();
        if (url !== undefined) partial.url = url;
        if (params !== undefined) partial.params = params;
        if (headers !== undefined) partial.headers = headers;
        if (body !== undefined) partial.body = body;
        if (auth !== undefined) partial.auth = auth;
        if (preRequestScript !== undefined) partial.preRequestScript = preRequestScript;
        if (testScript !== undefined) partial.testScript = testScript;
        if (settings !== undefined) {
          partial.settings = { ...(partial.settings ?? DEFAULT_SETTINGS), ...settings };
        }
        if (description !== undefined) partial.description = description;

        const created = repo.createRequest(folder.workspaceId, folderId, partial);
        return okJson(created);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "update_request",
    {
      title: "Update Request",
      description:
        "Edit an existing saved request's name, method, URL, query params, headers, body, auth, scripts, or settings.",
      inputSchema: {
        requestId: z.string().min(1).describe("Request ID to update"),
        name: z.string().min(1).max(300).optional(),
        method: z.string().optional(),
        url: z.string().optional(),
        params: z.array(keyValueSchema).optional(),
        headers: z.array(keyValueSchema).optional(),
        body: bodySchema.optional(),
        auth: authSchema.optional(),
        preRequestScript: z.string().optional(),
        testScript: z.string().optional(),
        settings: settingsPatchSchema.optional(),
        description: z.string().optional(),
      },
    },
    async ({ requestId, settings, method, ...rest }) => {
      try {
        const existing = repo.getRequest(requestId);
        if (!existing) throw new Error(`Request not found: ${requestId}`);
        const patch: Partial<RequestDef> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
        }
        if (method !== undefined) patch.method = method.toUpperCase();
        if (settings !== undefined) {
          patch.settings = { ...existing.settings, ...settings };
        }
        const updated = repo.updateRequest(requestId, patch);
        return okJson(updated);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "delete_request",
    {
      title: "Delete Request",
      description: "Delete a saved request by ID.",
      inputSchema: {
        requestId: z.string().min(1).describe("Request ID to delete"),
      },
    },
    async ({ requestId }) => {
      try {
        const existing = repo.getRequest(requestId);
        if (!existing) throw new Error(`Request not found: ${requestId}`);
        repo.deleteRequest(requestId);
        return okJson({ deleted: true, requestId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "duplicate_request",
    {
      title: "Duplicate Request",
      description: "Duplicate a saved request in the same folder.",
      inputSchema: {
        requestId: z.string().min(1).describe("Request ID to duplicate"),
      },
    },
    async ({ requestId }) => {
      try {
        const copy = repo.duplicateRequest(requestId);
        if (!copy) throw new Error(`Request not found: ${requestId}`);
        return okJson(copy);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "move_tree_item",
    {
      title: "Move or Reorder Folder/Request",
      description:
        "Move a folder or request into a target parent folder (or root for collections) at a specific 0-based index.",
      inputSchema: {
        kind: z.enum(["folder", "request"]).describe("Item kind"),
        id: z.string().min(1).describe("Folder or request ID"),
        parentId: z
          .string()
          .nullable()
          .describe("Target parent folder ID (or null to make a folder a top-level collection)"),
        index: z.number().int().min(0).default(0).describe("0-based position among siblings"),
      },
    },
    async ({ kind, id, parentId, index }) => {
      try {
        repo.reorder(kind, id, parentId, index);
        return okJson({ moved: true, kind, id, parentId, index });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ SEND / CODEGEN

  server.registerTool(
    "send_request",
    {
      title: "Send HTTP Request",
      description:
        "Execute a saved request (by `requestId`) or an ad-hoc request (via `url`/`method`/etc. or `curl`) through Postbox's server-side execution pipeline (pre-request scripts, {{variable}} resolution, inherited auth/headers, HTTP engine, and post-response `pm.test` scripts).",
      inputSchema: {
        requestId: z
          .string()
          .optional()
          .describe("Saved request ID to execute (any other fields provided act as temporary overrides)"),
        workspaceId: z
          .string()
          .optional()
          .describe("Workspace ID (inferred from requestId/folderId or defaults to primary workspace)"),
        environmentId: z
          .string()
          .nullable()
          .optional()
          .describe("Active environment ID for {{variable}} resolution"),
        folderId: z
          .string()
          .nullable()
          .optional()
          .describe("Folder ID for inheriting collection/folder auth, headers, and scripts"),
        curl: z.string().optional().describe("Optional cURL command to execute"),
        name: z.string().optional(),
        method: z.string().optional().describe("HTTP method override (e.g. GET, POST)"),
        url: z.string().optional().describe("Request URL (required if requestId and curl are omitted)"),
        params: z.array(keyValueSchema).optional(),
        headers: z.array(keyValueSchema).optional(),
        body: bodySchema.optional(),
        auth: authSchema.optional(),
        preRequestScript: z.string().optional(),
        testScript: z.string().optional(),
        settings: settingsPatchSchema.optional(),
        saveHistory: z.boolean().default(true).describe("Record this execution in workspace history"),
        maxBodyChars: z
          .number()
          .int()
          .min(256)
          .max(1_000_000)
          .default(65_536)
          .describe("Maximum characters of response body text returned in the tool output"),
      },
    },
    async (input) => {
      try {
        let baseRequest: RequestDef;
        let wsId: string;
        let folderId: string | null = input.folderId ?? null;

        if (input.requestId) {
          const saved = repo.getRequest(input.requestId);
          if (!saved) throw new Error(`Request not found: ${input.requestId}`);
          const { workspaceId: savedWsId, folderId: savedFolderId, sort: _s, ...reqDef } = saved;
          baseRequest = reqDef;
          wsId = input.workspaceId ?? savedWsId;
          folderId = input.folderId !== undefined ? input.folderId : savedFolderId;
        } else if (input.curl) {
          const parsed = parseCurl(input.curl);
          wsId = folderId
            ? (repo.getFolder(folderId)?.workspaceId ?? resolveWorkspaceId(input.workspaceId))
            : resolveWorkspaceId(input.workspaceId);
          baseRequest = defaultRequest({
            name: input.name ?? `${parsed.method} ${parsed.url}`,
            method: parsed.method,
            url: parsed.url,
            headers: parsed.headers,
            body: parsed.body,
            auth: parsed.auth,
            settings: {
              ...DEFAULT_SETTINGS,
              verifySsl: !parsed.insecure,
              followRedirects: parsed.followRedirects,
            },
          });
        } else {
          if (!input.url) {
            throw new Error("Provide `requestId`, `curl`, or `url` to send a request");
          }
          wsId = folderId
            ? (repo.getFolder(folderId)?.workspaceId ?? resolveWorkspaceId(input.workspaceId))
            : resolveWorkspaceId(input.workspaceId);
          baseRequest = defaultRequest({
            name: input.name ?? `${(input.method ?? "GET").toUpperCase()} ${input.url}`,
            method: (input.method ?? "GET").toUpperCase(),
            url: input.url,
          });
        }

        const mergedSettings: RequestSettings = {
          ...baseRequest.settings,
          ...(input.settings ?? {}),
        };
        const request: RequestDef = {
          ...baseRequest,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.method !== undefined ? { method: input.method.toUpperCase() } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.params !== undefined ? { params: input.params as KeyValue[] } : {}),
          ...(input.headers !== undefined ? { headers: input.headers as KeyValue[] } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.auth !== undefined ? { auth: input.auth } : {}),
          ...(input.preRequestScript !== undefined ? { preRequestScript: input.preRequestScript } : {}),
          ...(input.testScript !== undefined ? { testScript: input.testScript } : {}),
          settings: mergedSettings,
        };

        const result = await runSingleRequest({
          workspaceId: wsId,
          environmentId: input.environmentId ?? null,
          folderId,
          requestId: input.requestId ?? null,
          request,
          saveHistory: input.saveHistory,
        });

        const res = result.response;
        const bodyTruncated = res ? res.bodyText.length > input.maxBodyChars : false;
        const bodyText = res
          ? res.isBinary
            ? `[binary payload: ${res.size} bytes, content-type: ${res.contentType}]`
            : res.bodyText.slice(0, input.maxBodyChars)
          : undefined;

        return okJson({
          passed: !result.error && result.scriptErrors.length === 0 && result.tests.every((t) => t.passed),
          skipped: result.skipped,
          error: result.error,
          errorCode: result.errorCode,
          sent: result.sent,
          response: res
            ? {
                status: res.status,
                statusText: res.statusText,
                httpVersion: res.httpVersion,
                url: res.url,
                contentType: res.contentType,
                size: res.size,
                headersSize: res.headersSize,
                timings: res.timings,
                headers: res.headers,
                cookies: res.cookies,
                redirects: res.redirects,
                isBinary: res.isBinary,
                bodyTruncated,
                bodyText,
              }
            : null,
          tests: result.tests,
          scriptErrors: result.scriptErrors,
          logs: result.logs,
          unresolvedVariables: result.unresolved,
          warnings: result.warnings,
          historyId: result.historyId,
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "generate_code_snippet",
    {
      title: "Generate Code Snippet",
      description:
        "Generate a code snippet (curl, fetch, python, or powershell) for a saved request or ad-hoc request, with {{variables}} and inherited auth/headers resolved.",
      inputSchema: {
        language: z.enum(["curl", "fetch", "python", "powershell"]).default("curl"),
        requestId: z.string().optional().describe("Saved request ID"),
        workspaceId: z.string().optional(),
        environmentId: z.string().nullable().optional(),
        folderId: z.string().nullable().optional(),
        method: z.string().optional(),
        url: z.string().optional(),
        params: z.array(keyValueSchema).optional(),
        headers: z.array(keyValueSchema).optional(),
        body: bodySchema.optional(),
        auth: authSchema.optional(),
      },
    },
    async (input) => {
      try {
        let reqDef: RequestDef;
        let wsId: string;
        let folderId: string | null = input.folderId ?? null;

        if (input.requestId) {
          const saved = repo.getRequest(input.requestId);
          if (!saved) throw new Error(`Request not found: ${input.requestId}`);
          const { workspaceId: savedWsId, folderId: savedFolderId, sort: _s, ...rest } = saved;
          reqDef = rest;
          wsId = input.workspaceId ?? savedWsId;
          folderId = input.folderId !== undefined ? input.folderId : savedFolderId;
        } else {
          if (!input.url) throw new Error("Provide `requestId` or `url`");
          wsId = resolveWorkspaceId(input.workspaceId);
          reqDef = defaultRequest({
            method: (input.method ?? "GET").toUpperCase(),
            url: input.url,
            params: input.params ?? [],
            headers: input.headers ?? [],
            body: input.body ?? { mode: "none" },
            auth: input.auth ?? { type: "none" },
          });
        }

        if (folderId) repo.requireFolderIn(wsId, folderId);
        const chain = folderId ? repo.getFolderChain(folderId) : [];
        const collectionId = chain[0]?.id ?? null;
        const ctx = loadScopes(wsId, input.environmentId ?? null, collectionId);
        const resolver = new Resolver(ctx.scopes);
        const { prepared } = await prepareRequest(
          reqDef,
          chain,
          resolver,
          { policy: getPolicy() },
          { offline: true, defaults: executionSettings().requestDefaults },
        );
        const snippet = generateSnippet(input.language as CodegenLanguage, {
          method: prepared.method,
          url: prepared.url,
          headers: prepared.headers,
          body: reqDef.body,
        });

        return okJson({
          language: input.language,
          snippet,
          unresolvedVariables: [...resolver.unresolved],
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ COLLECTION RUNNER

  server.registerTool(
    "run_collection",
    {
      title: "Run Collection or Folder",
      description:
        "Execute all requests in a collection or folder sequentially using the Postbox collection runner. Supports multiple iterations, CSV/JSON iteration data, delays, stop-on-failure, and `pm.execution.setNextRequest`.",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID to run"),
        environmentId: z.string().nullable().optional().describe("Environment ID to use during the run"),
        iterations: z.number().int().min(1).max(1000).optional().describe("Number of iterations (default 1)"),
        delayMs: z.number().int().min(0).max(60_000).optional().describe("Delay between requests in ms"),
        stopOnFailure: z.boolean().optional().describe("Stop the run on the first failed request/test"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(300_000)
          .optional()
          .describe("Per-request timeout override in ms"),
        verifySsl: z.boolean().optional().describe("Verify TLS certificates"),
        persistVariables: z
          .boolean()
          .optional()
          .describe("Persist script variable changes after the run completes (default true)"),
        selectedRequestIds: z
          .array(z.string())
          .optional()
          .describe("Optional subset of request IDs to run (in tree order)"),
        dataCsv: z.string().optional().describe("Optional CSV string providing iteration data rows"),
        dataJson: z
          .string()
          .optional()
          .describe("Optional JSON array of objects providing iteration data rows"),
        dataRows: z
          .array(z.record(z.string(), z.string()))
          .optional()
          .describe("Optional array of key-value row objects for iteration data"),
      },
    },
    async (input) => {
      try {
        const folder = repo.getFolder(input.folderId);
        if (!folder) throw new Error(`Folder not found: ${input.folderId}`);

        let data: DataTable | null = null;
        let dataWarnings: string[] = [];
        if (input.dataCsv) {
          const parsed = readCsv(input.dataCsv);
          data = parsed.table;
          dataWarnings = parsed.warnings.map(formatIssue);
        } else if (input.dataJson) {
          data = parseJsonData(input.dataJson);
        } else if (input.dataRows?.length) {
          const cols = Array.from(new Set(input.dataRows.flatMap((r) => Object.keys(r))));
          data = { columns: cols, rows: input.dataRows };
        }

        const { runId, summary } = await runs.startRun({
          workspaceId: folder.workspaceId,
          folderId: input.folderId,
          environmentId: input.environmentId ?? null,
          options: {
            iterations: input.iterations ?? (data?.rows.length ? data.rows.length : 1),
            delayMs: input.delayMs ?? 0,
            stopOnFailure: input.stopOnFailure ?? false,
            timeoutMs: input.timeoutMs,
            verifySsl: input.verifySsl,
            persistVariables: input.persistVariables ?? true,
          },
          data,
          selectedRequestIds: input.selectedRequestIds ?? null,
          source: "mcp",
        });

        return okJson(dataWarnings.length ? { runId, summary, dataWarnings } : { runId, summary });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List Collection Runs",
      description: "List past collection runs for a workspace (optionally filtered by collection/folder ID).",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        folderId: z.string().optional().describe("Optional folder/collection ID filter"),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async ({ workspaceId, folderId, limit }) => {
      try {
        const wsId = folderId
          ? (repo.getFolder(folderId)?.workspaceId ?? resolveWorkspaceId(workspaceId))
          : resolveWorkspaceId(workspaceId);
        return okJson({ runs: runs.listRuns(wsId, folderId, limit) });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get Collection Run Details / Report",
      description:
        "Get the full summary and per-request results of a collection run, or render it as a JUnit XML or HTML report.",
      inputSchema: {
        runId: z.string().min(1).describe("Run ID"),
        format: z.enum(["json", "junit", "html"]).default("json").describe("Output report format"),
      },
    },
    async ({ runId, format }) => {
      try {
        const summary = runs.getRunSummary(runId);
        if (!summary) throw new Error(`Run not found: ${runId}`);
        if (format === "json") return okJson(summary);
        const report = renderReport(summary, format as ReportFormat);
        return {
          content: [{ type: "text", text: report.body }],
        };
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "delete_run",
    {
      title: "Delete Collection Run",
      description: "Delete a saved collection run and its results.",
      inputSchema: {
        runId: z.string().min(1).describe("Run ID to delete"),
      },
    },
    async ({ runId }) => {
      try {
        runs.deleteRun(runId);
        return okJson({ deleted: true, runId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ ENVIRONMENTS & VARIABLES

  server.registerTool(
    "list_environments",
    {
      title: "List Environments",
      description:
        "List all environments and their variables in a workspace (secrets are masked by default).",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        includeSecrets: z.boolean().default(false).describe("Include unmasked secret variable values"),
      },
    },
    async ({ workspaceId, includeSecrets }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        const list = repo.listEnvironments(wsId).map((e) => {
          const vars = repo.listVariables(wsId, "environment", e.id);
          return {
            ...e,
            variables: maskVariables(vars, includeSecrets),
          };
        });
        return okJson({ environments: list });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_environment",
    {
      title: "Get Environment",
      description: "Get a single environment and its variables by ID.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Environment ID"),
        includeSecrets: z.boolean().default(false).describe("Include unmasked secret variable values"),
      },
    },
    async ({ environmentId, includeSecrets }) => {
      try {
        const env = repo.getEnvironment(environmentId);
        if (!env) throw new Error(`Environment not found: ${environmentId}`);
        return okJson({
          ...env,
          variables: maskVariables(env.variables, includeSecrets),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "create_environment",
    {
      title: "Create Environment",
      description: "Create a new environment in a workspace with optional initial variables.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        name: z.string().min(1).max(200).describe("Environment name (e.g. Staging, Production)"),
        variables: z.array(variableInputSchema).optional().describe("Initial variables"),
      },
    },
    async ({ workspaceId, name, variables }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        const env = repo.createEnvironment(wsId, name, variables ?? []);
        return okJson({ ...env, variables: maskVariables(env.variables, false) });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "rename_environment",
    {
      title: "Rename Environment",
      description: "Rename an existing environment.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Environment ID"),
        name: z.string().min(1).max(200).describe("New environment name"),
      },
    },
    async ({ environmentId, name }) => {
      try {
        const env = repo.getEnvironment(environmentId);
        if (!env) throw new Error(`Environment not found: ${environmentId}`);
        repo.renameEnvironment(environmentId, name);
        const updated = repo.getEnvironment(environmentId)!;
        return okJson({ ...updated, variables: maskVariables(updated.variables, false) });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "delete_environment",
    {
      title: "Delete Environment",
      description: "Delete an environment and its variables.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Environment ID to delete"),
      },
    },
    async ({ environmentId }) => {
      try {
        const env = repo.getEnvironment(environmentId);
        if (!env) throw new Error(`Environment not found: ${environmentId}`);
        repo.deleteEnvironment(environmentId);
        return okJson({ deleted: true, environmentId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "list_variables",
    {
      title: "List Variables",
      description:
        "List variables in a given scope (`global`, `collection`, or `environment`). Secret values are masked unless `includeSecrets: true`.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        scope: z.enum(["global", "collection", "environment"]).describe("Variable scope"),
        ownerId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Collection folderId (when scope='collection') or environmentId (when scope='environment')",
          ),
        includeSecrets: z.boolean().default(false).describe("Include unmasked secret values"),
      },
    },
    async ({ workspaceId, scope, ownerId, includeSecrets }) => {
      try {
        let wsId: string;
        let resolvedOwner: string | null = null;
        if (scope === "collection") {
          if (!ownerId)
            throw new Error("ownerId (collection folderId) is required when scope is 'collection'");
          const folder = repo.getFolder(ownerId);
          if (!folder) throw new Error(`Collection folder not found: ${ownerId}`);
          const chain = repo.getFolderChain(ownerId);
          resolvedOwner = chain[0]?.id ?? ownerId;
          wsId = folder.workspaceId;
        } else if (scope === "environment") {
          if (!ownerId) throw new Error("ownerId (environmentId) is required when scope is 'environment'");
          const env = repo.getEnvironment(ownerId);
          if (!env) throw new Error(`Environment not found: ${ownerId}`);
          resolvedOwner = env.id;
          wsId = env.workspaceId;
        } else {
          wsId = resolveWorkspaceId(workspaceId);
        }
        const vars = repo.listVariables(wsId, scope, resolvedOwner);
        return okJson({
          workspaceId: wsId,
          scope,
          ownerId: resolvedOwner,
          variables: maskVariables(vars, includeSecrets),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "set_variables",
    {
      title: "Set or Replace Variables",
      description:
        "Create, update, or replace variables in `global`, `collection`, or `environment` scope. By default (`mode: 'merge'`), provided keys update existing variables or append new ones without removing other existing variables.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        scope: z.enum(["global", "collection", "environment"]).describe("Variable scope"),
        ownerId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Collection folderId (when scope='collection') or environmentId (when scope='environment')",
          ),
        mode: z
          .enum(["merge", "replace"])
          .default("merge")
          .describe("'merge' upserts by key; 'replace' overwrites the entire scope variable list"),
        variables: z.array(variableInputSchema).describe("Variables to set"),
      },
    },
    async ({ workspaceId, scope, ownerId, mode, variables }) => {
      try {
        let wsId: string;
        let resolvedOwner: string | null = null;
        if (scope === "collection") {
          if (!ownerId)
            throw new Error("ownerId (collection folderId) is required when scope is 'collection'");
          const folder = repo.getFolder(ownerId);
          if (!folder) throw new Error(`Collection folder not found: ${ownerId}`);
          const chain = repo.getFolderChain(ownerId);
          resolvedOwner = chain[0]?.id ?? ownerId;
          wsId = folder.workspaceId;
        } else if (scope === "environment") {
          if (!ownerId) throw new Error("ownerId (environmentId) is required when scope is 'environment'");
          const env = repo.getEnvironment(ownerId);
          if (!env) throw new Error(`Environment not found: ${ownerId}`);
          resolvedOwner = env.id;
          wsId = env.workspaceId;
        } else {
          wsId = resolveWorkspaceId(workspaceId);
        }

        let nextList: Variable[];
        if (mode === "replace") {
          nextList = variables;
        } else {
          const current = repo.listVariables(wsId, scope, resolvedOwner);
          nextList = [...current];
          for (const incoming of variables) {
            const idx = nextList.findIndex((v) => v.key === incoming.key);
            if (idx >= 0) nextList[idx] = { ...nextList[idx], ...incoming };
            else nextList.push(incoming);
          }
        }

        repo.replaceVariables(wsId, scope, resolvedOwner, nextList);
        const saved = repo.listVariables(wsId, scope, resolvedOwner);
        return okJson({
          workspaceId: wsId,
          scope,
          ownerId: resolvedOwner,
          variables: maskVariables(saved, false),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ IMPORT / EXPORT

  server.registerTool(
    "import_spec",
    {
      title: "Import Postman / OpenAPI Spec",
      description:
        "Import a Postman Collection (v2.0/v2.1), Postman Environment, or OpenAPI 3.x / Swagger 2.0 specification (JSON or YAML) from raw text or a URL into a workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        content: z.string().optional().describe("Raw JSON or YAML specification content"),
        url: z.string().url().optional().describe("URL to fetch the specification from"),
      },
    },
    async ({ workspaceId, content, url }) => {
      try {
        if (!content && !url) throw new Error("Provide either `content` or `url`");
        const wsId = resolveWorkspaceId(workspaceId);
        let raw = content ?? "";
        if (url) {
          const res = await sendRequest(
            {
              method: "GET",
              url,
              headers: [["Accept", "application/json, application/yaml, */*"]],
              settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
            },
            { policy: getPolicy() },
          );
          if (res.status >= 400) {
            throw new Error(`Fetching ${url} failed with HTTP ${res.status}`);
          }
          raw = res.bodyText;
        }
        const outcome = importContent(wsId, raw, url);
        return okJson(outcome);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "export_collection",
    {
      title: "Export Postman Collection",
      description: "Export a collection or folder tree as a Postman Collection v2.1 JSON object.",
      inputSchema: {
        folderId: z.string().min(1).describe("Collection or folder ID to export"),
        includeSecrets: z.boolean().default(false).describe("Include secret collection variable values"),
      },
    },
    async ({ folderId, includeSecrets }) => {
      try {
        const folder = repo.getFolder(folderId);
        if (!folder) throw new Error(`Folder not found: ${folderId}`);
        const tree = repo.getFolderTree(folderId);
        if (!tree) throw new Error(`Folder tree not found: ${folderId}`);
        const chain = repo.getFolderChain(folderId);
        const collectionId = chain[0]?.id ?? folderId;
        const vars = repo.listVariables(folder.workspaceId, "collection", collectionId);
        const exported = exportPostmanCollection(tree, vars, { includeSecrets });
        return okJson(exported);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "export_environment",
    {
      title: "Export Postman Environment",
      description: "Export an environment as a Postman Environment JSON object.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Environment ID to export"),
        includeSecrets: z.boolean().default(false).describe("Include secret variable values"),
      },
    },
    async ({ environmentId, includeSecrets }) => {
      try {
        const env = repo.getEnvironment(environmentId);
        if (!env) throw new Error(`Environment not found: ${environmentId}`);
        const exported = exportPostmanEnvironment(env.name, env.variables, { includeSecrets });
        return okJson(exported);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ================================================================ HISTORY & COOKIES

  server.registerTool(
    "list_history",
    {
      title: "List Request History",
      description: "List recent single-request executions in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ workspaceId, limit }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        return okJson({ history: repo.listHistory(wsId, limit) });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_history_entry",
    {
      title: "Get History Entry",
      description: "Get the full request and response snapshot for a history entry.",
      inputSchema: {
        historyId: z.string().min(1).describe("History entry ID"),
      },
    },
    async ({ historyId }) => {
      try {
        const entry = repo.getHistory(historyId);
        if (!entry) throw new Error(`History entry not found: ${historyId}`);
        return okJson(entry);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "clear_history",
    {
      title: "Clear Request History",
      description: "Clear all request history entries in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
      },
    },
    async ({ workspaceId }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        repo.clearHistory(wsId);
        return okJson({ cleared: true, workspaceId: wsId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "list_cookies",
    {
      title: "List Workspace Cookies",
      description: "List cookies stored in the workspace cookie jar.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
      },
    },
    async ({ workspaceId }) => {
      try {
        const wsId = resolveWorkspaceId(workspaceId);
        return okJson({ cookies: repo.listCookies(wsId) });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "clear_cookies",
    {
      title: "Clear or Delete Workspace Cookies",
      description: "Delete a single cookie by `cookieId`, or clear the entire cookie jar for a workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (defaults to primary workspace)"),
        cookieId: z.string().optional().describe("If provided, delete only this cookie ID"),
      },
    },
    async ({ workspaceId, cookieId }) => {
      try {
        if (cookieId) {
          repo.deleteCookie(cookieId);
          return okJson({ deleted: true, cookieId });
        }
        const wsId = resolveWorkspaceId(workspaceId);
        repo.clearCookies(wsId);
        return okJson({ cleared: true, workspaceId: wsId });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  return server;
}
