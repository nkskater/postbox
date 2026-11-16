import type { McpToolset } from "@/lib/mcp-toolsets";

const CORE = new Set([
  "whoami",
  "list_workspaces",
  "create_workspace",
  "rename_workspace",
  "delete_workspace",
  "get_workspace_tree",
  "get_folder",
  "create_folder",
  "update_folder",
  "delete_folder",
  "duplicate_folder",
  "get_request",
  "create_request",
  "update_request",
  "delete_request",
  "duplicate_request",
  "move_tree_item",
  "send_request",
  "run_collection",
  "list_runs",
  "get_run",
  "delete_run",
  "list_environments",
  "get_environment",
  "create_environment",
  "rename_environment",
  "delete_environment",
  "list_variables",
  "set_variables",
  "export_collection",
  "export_environment",
  "list_history",
  "get_history_entry",
  "clear_history",
  "list_cookies",
  "clear_cookies",
]);
const DOMAINS: [McpToolset, RegExp][] = [
  ["mocks", /mock/],
  ["monitors", /monitor/],
  ["governance", /governance/],
  ["specs", /specification|^import_spec$|^validate_request_contract$/],
  ["scorecards", /scorecard/],
  ["datasets", /dataset/],
  ["vault-broker", /vault|broker/],
  ["telemetry", /telemetry/],
  ["catalog-docs", /catalog|documentation/],
  ["capture", /capture/],
  ["load", /load/],
  ["packages", /script_package/],
  ["graph", /^graph_/],
  ["comments", /comment/],
  ["examples", /request_examples/],
  ["codegen", /code_snippet/],
];
export function toolsetOf(name: string): McpToolset {
  if (CORE.has(name)) return "core";
  const domain = DOMAINS.find(([, pattern]) => pattern.test(name));
  if (!domain) throw new Error(`MCP tool ${name} needs a toolset classification`);
  return domain[0];
}
