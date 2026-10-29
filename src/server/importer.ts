/**
 * Detects and imports Postman collections/environments and OpenAPI specs.
 * Shared by /api/import and the MCP server.
 */
import { importOpenApi, isOpenApi, parseSpec } from "@/core/convert/openapi";
import {
  importPostmanCollection,
  importPostmanEnvironment,
  isPostmanCollection,
  isPostmanEnvironment,
} from "@/core/convert/postman";
import * as repo from "./repo";

export type ImportOutcome =
  | {
      kind: "collection";
      id: string;
      name: string;
      folders: number;
      requests: number;
      source: "postman" | "openapi";
    }
  | { kind: "environment"; id: string; name: string; variables: number }
  | { kind: "globals"; variables: number };

export function importContent(workspaceId: string, content: string, sourceUrl?: string): ImportOutcome {
  let data: unknown;
  try {
    data = parseSpec(content);
  } catch {
    throw new Error("Content is neither valid JSON nor YAML");
  }
  if (isPostmanCollection(data)) {
    const { root, variables } = importPostmanCollection(data);
    return { kind: "collection", source: "postman", ...repo.importTree(workspaceId, root, variables) };
  }
  if (isOpenApi(data)) {
    const { root, variables } = importOpenApi(data, { sourceUrl });
    return { kind: "collection", source: "openapi", ...repo.importTree(workspaceId, root, variables) };
  }
  if (isPostmanEnvironment(data)) {
    const env = importPostmanEnvironment(data);
    if (env.isGlobals) {
      const existing = repo.listVariables(workspaceId, "global", null);
      const merged = [
        ...existing.filter((v) => !env.variables.some((n) => n.key === v.key)),
        ...env.variables,
      ];
      repo.replaceVariables(workspaceId, "global", null, merged);
      return { kind: "globals", variables: env.variables.length };
    }
    const created = repo.createEnvironment(workspaceId, env.name, env.variables);
    return { kind: "environment", id: created.id, name: created.name, variables: env.variables.length };
  }
  throw new Error(
    "Unrecognised format. Supported: Postman collection v2.0/v2.1, Postman environment, OpenAPI 3.x, Swagger 2.0",
  );
}
