import { importSoapUi, isSoapUiXml, type SoapUiCounts, type SoapUiDiagnostic } from "@/core/convert/soapui";
import { importThunderClient, isThunderClient } from "@/core/convert/thunder";
import { importHar, isHar } from "@/core/convert/har";
import { importHoppscotch, isHoppscotch } from "@/core/convert/hoppscotch";
import { importInsomnia, isInsomnia } from "@/core/convert/insomnia";
import { getDb } from "./db";
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
import { isPostmanV3, postmanV3ToV21, type V3Diagnostic } from "@/core/convert/postman-v3";
import type { FolderNode } from "@/core/types";
import * as repo from "./repo";

export interface SoapUiPreview {
  kind: "preview";
  source: "soapui";
  name: string;
  folders: number;
  requests: number;
  variables: number;
  sourceCounts: SoapUiCounts;
  diagnostics: SoapUiDiagnostic[];
  warnings: string[];
  includeCredentials: boolean;
}
/** What a Postman v3 file would create and what it holds that Postbox cannot keep. */
export interface PostmanV3Preview {
  kind: "preview";
  source: "postman-v3";
  name: string;
  folders: number;
  requests: number;
  variables: number;
  diagnostics: V3Diagnostic[];
  warnings: string[];
}
const v3Warnings = (diagnostics: V3Diagnostic[]) =>
  diagnostics.map((entry) => `${entry.path}: ${entry.message}`);
const countTree = (node: FolderNode): { folders: number; requests: number } =>
  node.children.reduce(
    (total, child) => {
      if (child.kind === "request") total.requests++;
      else {
        const nested = countTree(child);
        total.folders += nested.folders + 1;
        total.requests += nested.requests;
      }
      return total;
    },
    { folders: 0, requests: 0 },
  );

export type ImportOutcome =
  | SoapUiPreview
  | PostmanV3Preview
  | {
      kind: "collection";
      id: string;
      name: string;
      folders: number;
      requests: number;
      source:
        | "postman"
        | "postman-v3"
        | "openapi"
        | "har"
        | "hoppscotch"
        | "thunder-client"
        | "insomnia"
        | "soapui";
      sourceCounts?: SoapUiCounts;
      diagnostics?: SoapUiDiagnostic[];
      warnings?: string[];
    }
  | { kind: "environment"; id: string; name: string; variables: number; warnings?: string[] }
  | { kind: "globals"; variables: number }
  | { kind: "batch"; items: ImportOutcome[]; warnings: string[] };

export function importContent(
  workspaceId: string,
  content: string,
  sourceUrl?: string,
  options: { includeCredentials?: boolean; preview?: boolean } = {},
): ImportOutcome {
  if (isSoapUiXml(content) || /^\uFEFF?\s*</.test(content)) {
    const converted = importSoapUi(content, options);
    const countFolders = (node: typeof converted.root): number =>
      1 +
      node.children.reduce((total, child) => total + (child.kind === "folder" ? countFolders(child) : 0), 0);
    const metadata = {
      sourceCounts: converted.sourceCounts,
      diagnostics: converted.diagnostics,
      warnings: converted.warnings,
    };
    if (options.preview)
      return {
        kind: "preview",
        source: "soapui",
        name: converted.root.name,
        folders: countFolders(converted.root) - 1,
        requests: converted.sourceCounts.convertedRequests,
        variables: converted.variables.length,
        includeCredentials: options.includeCredentials === true,
        ...metadata,
      };
    return {
      kind: "collection",
      source: "soapui",
      ...repo.importTree(workspaceId, converted.root, converted.variables),
      ...metadata,
    };
  }
  let data: unknown;
  try {
    data = parseSpec(content);
  } catch {
    if (options.preview)
      throw new Error(
        "Preview currently supports SoapUI XML projects and Postman v3 collections. No data was imported.",
      );
    throw new Error("Content is neither valid JSON nor YAML");
  }
  if (isPostmanV3(data)) {
    const { collection, diagnostics } = postmanV3ToV21(data);
    const { root, variables } = importPostmanCollection(collection);
    const warnings = v3Warnings(diagnostics);
    if (options.preview)
      return {
        kind: "preview",
        source: "postman-v3",
        name: root.name,
        ...countTree(root),
        variables: variables.length,
        diagnostics,
        warnings,
      };
    return {
      kind: "collection",
      source: "postman-v3",
      ...repo.importTree(workspaceId, root, variables),
      warnings,
    };
  }
  if (options.preview)
    throw new Error(
      "Preview currently supports SoapUI XML projects and Postman v3 collections. No data was imported.",
    );
  if (isHar(data)) {
    const { root, variables, warnings } = importHar(data);
    return { kind: "collection", source: "har", ...repo.importTree(workspaceId, root, variables), warnings };
  }
  if (isThunderClient(data)) {
    const result = importThunderClient(data, options);
    if (result.kind === "collection")
      return {
        kind: "collection",
        source: "thunder-client",
        ...repo.importTree(workspaceId, result.root, result.variables),
        warnings: result.warnings,
      };
    const environment = repo.createEnvironment(workspaceId, result.name, result.variables);
    return {
      kind: "environment",
      id: environment.id,
      name: environment.name,
      variables: result.variables.length,
      warnings: result.warnings,
    };
  }
  if (isInsomnia(data)) {
    const converted = importInsomnia(data, options);
    return getDb().transaction(() => {
      const items: ImportOutcome[] = [
        ...converted.collections.map((c): ImportOutcome => ({
          kind: "collection",
          source: "insomnia",
          ...repo.importTree(workspaceId, c.root, c.variables),
          warnings: converted.warnings,
        })),
        ...converted.environments.map((e): ImportOutcome => {
          const created = repo.createEnvironment(workspaceId, e.name, e.variables);
          return { kind: "environment", id: created.id, name: created.name, variables: e.variables.length };
        }),
      ];
      return items.length === 1 ? items[0] : { kind: "batch", items, warnings: converted.warnings };
    });
  }
  if (isPostmanCollection(data)) {
    const { root, variables } = importPostmanCollection(data);
    return { kind: "collection", source: "postman", ...repo.importTree(workspaceId, root, variables) };
  }
  if (isHoppscotch(data)) {
    const converted = importHoppscotch(data, options);
    return getDb().transaction(() => {
      const items: ImportOutcome[] = converted.items.map((item) => {
        if (item.kind === "collection")
          return {
            kind: "collection",
            source: "hoppscotch",
            ...repo.importTree(workspaceId, item.root, item.variables),
            warnings: converted.warnings,
          };
        const created = repo.createEnvironment(workspaceId, item.name, item.variables);
        return { kind: "environment", id: created.id, name: created.name, variables: item.variables.length };
      });
      return items.length === 1 ? items[0] : { kind: "batch", items, warnings: converted.warnings };
    });
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
    "Unrecognised format. Supported: Postman collection v2.0/v2.1/v3, Postman environment, OpenAPI 3.x, Swagger 2.0, HAR 1.2, Hoppscotch, Thunder Client, Insomnia v4/v5, SoapUI XML projects",
  );
}
