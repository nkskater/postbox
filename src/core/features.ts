/**
 * Optional feature areas. Each can be switched off by an administrator (Settings → Features, or a
 * `POSTBOX_FEATURE_*` environment variable). Switching an area off hides its sidebar tab, panels and
 * settings, answers its REST routes with 404, hides and refuses its MCP tools and stops its
 * background worker. Its data stays in the database, so switching it back on restores everything.
 *
 * Everything not listed here is core: workspaces, collections and requests, the runner and
 * schedules, pre-request and test scripts, variables, secrets and the vault, environments,
 * history, import/export, accounts and administration.
 */

export interface FeatureDef {
  id: string;
  label: string;
  description: string;
  /** Sidebar views (`sidebarView` ids). */
  views?: readonly string[];
  /**
   * Path prefixes served by this area: REST routes and public pages. A `*` stands for one path
   * segment (for area routes nested under a core resource); a trailing `/` matches anything below.
   */
  paths: readonly string[];
  /** MCP toolsets (see src/lib/mcp-toolsets.ts) whose tools belong to this area. */
  toolsets?: readonly string[];
  /** MCP tools matched by name, for areas that share a toolset with core. */
  tools?: RegExp;
  /** Background workers started at boot (names used by src/instrumentation.ts). */
  workers?: readonly string[];
}

export const FEATURES = [
  {
    id: "assistant",
    label: "AI assistant and AI requests",
    description: "The API assistant tab and requests that call a language model (the AI body type).",
    views: ["assistant"],
    paths: ["/api/ai"],
  },
  {
    id: "telemetry",
    label: "Production telemetry",
    description: "Import production traffic summaries and compare them with collections.",
    views: ["telemetry"],
    paths: ["/api/telemetry"],
    toolsets: ["telemetry"],
    workers: ["telemetry-retention"],
  },
  {
    id: "governance",
    label: "Governance and scorecards",
    description: "API style rules, rule sets and scorecards.",
    views: ["governance"],
    paths: ["/api/governance", "/api/scorecards"],
    toolsets: ["governance", "scorecards"],
  },
  {
    id: "specifications",
    label: "API specifications",
    description: "OpenAPI and AsyncAPI specifications, their versions and links to collections.",
    views: ["specifications"],
    paths: ["/api/specifications", "/api/folders/*/specification", "/api/requests/*/contract-validation"],
    toolsets: ["specs"],
  },
  {
    id: "monitors",
    label: "Monitors and private runners",
    description: "Uptime and contract monitors on schedules, incidents, alert email and private runners.",
    views: ["monitors"],
    paths: ["/api/monitors", "/api/runners", "/api/runner-agent"],
    toolsets: ["monitors"],
    workers: ["monitor-email"],
  },
  {
    id: "mcp-client",
    label: "MCP client",
    description: "Connect to other MCP servers and call their tools from Postbox.",
    views: ["mcp-client"],
    paths: ["/api/mcp-client"],
  },
  {
    id: "catalog",
    label: "API catalog and documentation",
    description: "The API catalog and published collection documentation.",
    views: ["catalog"],
    paths: ["/api/catalog", "/api/documentation", "/api/folders/*/catalog", "/api/folders/*/documentation"],
    toolsets: ["catalog-docs"],
  },
  {
    id: "graph",
    label: "Dependency graph",
    description: "The graph of how requests, collections, specifications and services depend on each other.",
    views: ["graph"],
    paths: ["/api/graph"],
    toolsets: ["graph"],
  },
  {
    id: "packages",
    label: "Script packages",
    description:
      "Shared script libraries that scripts can require. Scripts that already use a package keep working.",
    views: ["packages"],
    paths: ["/api/script-packages"],
    toolsets: ["packages"],
  },
  {
    id: "mocks",
    label: "Mock servers",
    description: "Mock servers built from examples, and their public mock endpoints.",
    views: ["mocks"],
    paths: ["/api/mocks", "/mock/"],
    toolsets: ["mocks"],
  },
  {
    id: "datasets",
    label: "Datasets",
    description: "Versioned data files for data-driven collection runs.",
    views: ["datasets"],
    paths: ["/api/datasets"],
    toolsets: ["datasets"],
  },
  {
    id: "load",
    label: "Load testing",
    description: "Load tests from the collection runner.",
    paths: ["/api/load-runs"],
    toolsets: ["load"],
  },
  {
    id: "capture",
    label: "Traffic capture",
    description: "Record traffic through a capture proxy and turn it into requests.",
    paths: ["/api/capture", "/capture/"],
    toolsets: ["capture"],
  },
  {
    id: "broker",
    label: "Credential broker",
    description: "Brokered APIs that let callers use stored credentials without seeing them.",
    paths: ["/api/broker"],
    tools: /broker/,
  },
  {
    id: "collaboration",
    label: "Comments, forks and merge requests",
    description:
      "Comment threads on requests, collections and specifications, collection forks and merge requests.",
    paths: [
      "/api/comments",
      "/api/forks",
      "/api/merge-requests",
      "/api/folders/*/comments",
      "/api/folders/*/forks",
      "/api/requests/*/comments",
    ],
    toolsets: ["comments"],
  },
  {
    id: "releases",
    label: "Collection releases and dependencies",
    description: "Published collection and environment releases, and installing them into other workspaces.",
    paths: [
      "/api/dependencies",
      "/api/dependency-releases",
      "/api/folders/*/releases",
      "/api/environments/*/releases",
    ],
  },
  {
    id: "workflows",
    label: "Visual workflows",
    description: "Visual API workflows, their versions, deployments and triggers.",
    paths: [
      "/api/workflows",
      "/api/workflow-runs",
      "/api/workflow-deployments",
      "/api/workflow-triggers",
      "/flows",
    ],
    workers: ["workflow-scheduler"],
  },
  {
    id: "webhooks",
    label: "Outgoing webhooks",
    description: "Send workspace events (runs, monitors, changes) to other services.",
    paths: ["/api/webhooks"],
    workers: ["webhook-delivery"],
  },
  {
    id: "hooks",
    label: "Incoming webhook listeners",
    description: "Endpoints that record requests other services send to Postbox.",
    paths: ["/api/hook-listeners", "/hook/"],
  },
] as const satisfies readonly FeatureDef[];

export type FeatureId = (typeof FEATURES)[number]["id"];
export const FEATURE_IDS = FEATURES.map((f) => f.id) as FeatureId[];
export const featureSettingKey = (id: FeatureId) => `features.${id}`;
export const featureEnvName = (id: FeatureId) => `POSTBOX_FEATURE_${id.toUpperCase().replace(/-/g, "_")}`;

/**
 * Core REST areas (top-level segments under /api). Every directory under src/app/api must be core
 * or belong to a feature; a test enforces it.
 */
export const CORE_API_AREAS = [
  "admin",
  "auth",
  "backup",
  "codegen",
  "cookies",
  "environments",
  "export",
  "folders",
  // The gateway keeps its own GATEWAY_ENABLED switch.
  "gateway",
  "graphql",
  "grpc",
  "health",
  "history",
  "import",
  "invites",
  "mcp",
  "me",
  "mqtt",
  "notifications",
  "oauth2",
  "openapi.json",
  "proxy",
  "requests",
  "runs",
  "schedules",
  "scim",
  "settings",
  "socketio",
  "sse",
  "tree",
  "variables",
  "vault",
  "workspaces",
  "ws",
] as const;

/** MCP toolsets that are core. Vault tools are core; broker tools are matched by name. */
export const CORE_TOOLSETS = ["core", "vault-broker", "examples", "codegen"] as const;

/** Core sidebar views. */
export const CORE_VIEWS = ["collections", "environments", "history"] as const;

const pathPatterns = new Map<string, RegExp>();
function matchesPath(pathname: string, prefix: string) {
  let pattern = pathPatterns.get(prefix);
  if (!pattern) {
    const open = prefix.endsWith("/");
    const body = (open ? prefix.slice(0, -1) : prefix)
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+");
    pattern = new RegExp(`^${body}${open ? "/" : "(?:/|$)"}`);
    pathPatterns.set(prefix, pattern);
  }
  return pattern.test(pathname);
}

/** The feature a path belongs to, or null for core. */
export function featureOfPath(pathname: string): FeatureId | null {
  for (const f of FEATURES as readonly FeatureDef[])
    if (f.paths.some((p) => matchesPath(pathname, p))) return f.id as FeatureId;
  return null;
}

/** The feature an MCP tool belongs to, or null for core. */
export function featureOfTool(name: string, toolset: string): FeatureId | null {
  for (const f of FEATURES as readonly FeatureDef[]) {
    if (f.tools?.test(name)) return f.id as FeatureId;
    if (f.toolsets?.includes(toolset)) return f.id as FeatureId;
  }
  return null;
}

/** The feature a sidebar view belongs to, or null for core. */
export function featureOfView(view: string): FeatureId | null {
  return ((FEATURES as readonly FeatureDef[]).find((f) => f.views?.includes(view))?.id as FeatureId) ?? null;
}

export function featureOfWorker(worker: string): FeatureId | null {
  return (
    ((FEATURES as readonly FeatureDef[]).find((f) => f.workers?.includes(worker))?.id as FeatureId) ?? null
  );
}

export function featureLabel(id: FeatureId): string {
  return FEATURES.find((f) => f.id === id)!.label;
}

export interface FeaturePreset {
  id: string;
  label: string;
  description: string;
  /** Areas switched on by this preset; every other area is switched off. */
  features: readonly FeatureId[];
}

/** Named groups of switches, applied in one step under Settings → Features or by POSTBOX_FEATURE_PRESET. */
export const FEATURE_PRESETS: readonly FeaturePreset[] = [
  {
    id: "minimal",
    label: "Minimal",
    description:
      "The API client only: workspaces, collections, the runner and schedules, scripts, variables, secrets, environments and history.",
    features: [],
  },
  {
    id: "team",
    label: "Team",
    description:
      "Minimal plus comments, forks and merge requests, collection releases, monitors, mocks, datasets and outgoing webhooks.",
    features: ["collaboration", "releases", "monitors", "mocks", "datasets", "webhooks"],
  },
  {
    id: "api-design",
    label: "API design",
    description:
      "Minimal plus specifications, governance, the catalog and documentation, the dependency graph, mocks and comments.",
    features: ["specifications", "governance", "catalog", "graph", "mocks", "collaboration"],
  },
  {
    id: "full",
    label: "Full",
    description: "Every area on.",
    features: FEATURE_IDS,
  },
];

export const FEATURE_PRESET_ENV = "POSTBOX_FEATURE_PRESET";

export function featurePreset(id: string | undefined): FeaturePreset | undefined {
  const key = id?.trim().toLowerCase();
  return key ? FEATURE_PRESETS.find((p) => p.id === key) : undefined;
}

/** The switch values a preset applies, keyed by setting key. */
export function presetSwitches(preset: FeaturePreset): Record<string, boolean> {
  return Object.fromEntries(FEATURE_IDS.map((id) => [featureSettingKey(id), preset.features.includes(id)]));
}

/** The preset whose switches match exactly, or undefined ("Custom"). */
export function matchingPreset(enabled: ReadonlySet<string>): FeaturePreset | undefined {
  return FEATURE_PRESETS.find(
    (p) => p.features.length === enabled.size && p.features.every((id) => enabled.has(id)),
  );
}
