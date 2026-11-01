/**
 * App settings registry: the single source of truth for every user-facing setting.
 * The Settings page is generated from it, the server validates against it, and
 * consumers read values by key. Shared by browser and server (no Node imports).
 *
 * To add a setting: add an entry here, then read it where it is used.
 */
import { isValidAccent, DEFAULT_ACCENT } from "./accent";

export type SettingCategory =
  | "appearance"
  | "layout"
  | "editor"
  | "requests"
  | "responses"
  | "tabs"
  | "variables"
  | "console"
  | "runner"
  | "execution"
  | "data";

export const CATEGORIES: { id: SettingCategory; label: string; description: string }[] = [
  { id: "appearance", label: "Appearance", description: "Theme, colors, typography and density." },
  { id: "layout", label: "Layout", description: "Where panels live and how they are arranged." },
  { id: "editor", label: "Editor", description: "Code editors for bodies, scripts and responses." },
  {
    id: "requests",
    label: "Requests",
    description: "Defaults for new requests and how the URL bar behaves.",
  },
  { id: "responses", label: "Responses", description: "How responses are displayed." },
  { id: "tabs", label: "Tabs", description: "Opening, restoring and closing tabs." },
  {
    id: "variables",
    label: "Variables & secrets",
    description: "How variables and secret values are shown.",
  },
  { id: "console", label: "Console", description: "Script console and network log." },
  { id: "runner", label: "Collection runner", description: "Defaults used when you open the runner." },
  {
    id: "execution",
    label: "Request execution",
    description: "Server-side defaults for every request and script. Administrators only.",
  },
  {
    id: "data",
    label: "History & data",
    description: "How long request history is kept, backups, and database maintenance. Administrators only.",
  },
];

interface Base<T> {
  key: string;
  category: SettingCategory;
  label: string;
  description: string;
  default: T;
  /** browser: applied in the UI; server: read by the server (may be pinned by an env var). */
  scope: "browser" | "server";
  /** Environment variable that overrides the saved value (server settings). */
  env?: string;
  keywords?: string[];
}

export type SettingDef =
  | (Base<string> & { type: "select"; options: { value: string; label: string }[] })
  | (Base<boolean> & { type: "boolean" })
  | (Base<number> & { type: "number"; min: number; max: number; step?: number; unit?: string })
  | (Base<string> & { type: "accent" })
  | (Base<string> & { type: "text"; maxLength: number; placeholder?: string })
  | (Base<HeaderRow[]> & { type: "keyvalue"; maxRows: number });

/** One row of a key/value list setting (same shape as a request header row). */
export interface HeaderRow {
  key: string;
  value: string;
  enabled: boolean;
}

export type SettingValue = string | number | boolean | HeaderRow[];

export const SETTINGS: SettingDef[] = [
  {
    key: "appearance.theme",
    category: "appearance",
    label: "Theme",
    description: "Dark, light, or follow your operating system.",
    type: "select",
    scope: "browser",
    default: "dark",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "system", label: "System" },
    ],
    keywords: ["dark mode", "light mode", "color scheme"],
  },
  {
    key: "appearance.accent",
    category: "appearance",
    label: "Accent color",
    description:
      "Used for primary buttons, the active tab, links and focus rings. Pick a preset or any custom color.",
    type: "accent",
    scope: "browser",
    default: DEFAULT_ACCENT,
    keywords: ["primary", "brand", "orange", "color", "colour", "highlight"],
  },
  {
    key: "appearance.tone",
    category: "appearance",
    label: "Background tone",
    description: "The tint of backgrounds, borders and muted text.",
    type: "select",
    scope: "browser",
    default: "zinc",
    options: [
      { value: "neutral", label: "Neutral" },
      { value: "zinc", label: "Zinc" },
      { value: "slate", label: "Slate" },
      { value: "ocean", label: "Ocean" },
      { value: "stone", label: "Stone" },
      { value: "warm", label: "Warm" },
    ],
    keywords: ["palette", "gray", "grey", "background", "tint"],
  },
  {
    key: "appearance.oled",
    category: "appearance",
    label: "True black (OLED)",
    description: "Use pure black backgrounds in the dark theme.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["amoled", "black", "dark"],
  },
  {
    key: "appearance.fontSize",
    category: "appearance",
    label: "Interface font size",
    description: "Scales all text and controls in the interface.",
    type: "number",
    scope: "browser",
    default: 14,
    min: 12,
    max: 18,
    step: 1,
    unit: "px",
    keywords: ["zoom", "scale", "text size"],
  },
  {
    key: "appearance.fontFamily",
    category: "appearance",
    label: "Interface font",
    description:
      "Font used for the interface. Fonts must be installed on this computer; otherwise the system font is used.",
    type: "select",
    scope: "browser",
    default: "system",
    options: [
      { value: "system", label: "System default" },
      { value: "inter", label: "Inter" },
      { value: "plex", label: "IBM Plex Sans" },
      { value: "segoe", label: "Segoe UI" },
      { value: "roboto", label: "Roboto" },
      { value: "ubuntu", label: "Ubuntu" },
      { value: "mono", label: "Monospace" },
    ],
    keywords: ["typeface", "typography"],
  },
  {
    key: "appearance.density",
    category: "appearance",
    label: "Density",
    description: "Spacing between and inside controls.",
    type: "select",
    scope: "browser",
    default: "comfortable",
    options: [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
      { value: "spacious", label: "Spacious" },
    ],
    keywords: ["spacing", "padding", "compact"],
  },
  {
    key: "appearance.radius",
    category: "appearance",
    label: "Corner radius",
    description: "Roundness of buttons, inputs and panels.",
    type: "select",
    scope: "browser",
    default: "default",
    options: [
      { value: "sharp", label: "Sharp" },
      { value: "default", label: "Default" },
      { value: "round", label: "Round" },
    ],
    keywords: ["rounded", "corners", "border radius"],
  },
  {
    key: "appearance.reduceMotion",
    category: "appearance",
    label: "Reduce motion",
    description: "Turn off animations and transitions.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["animation", "accessibility"],
  },
  {
    key: "layout.sidebarPosition",
    category: "layout",
    label: "Sidebar position",
    description: "Show the collections sidebar on the left or the right.",
    type: "select",
    scope: "browser",
    default: "left",
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
    keywords: ["panel", "side"],
  },
  {
    key: "layout.sidebarLabels",
    category: "layout",
    label: "Sidebar rail labels",
    description: "Show text labels under the sidebar icons.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["icons", "rail"],
  },
  {
    key: "layout.requestLayout",
    category: "layout",
    label: "Request & response layout",
    description: "Stack the response below the request, or place them side by side.",
    type: "select",
    scope: "browser",
    default: "stacked",
    options: [
      { value: "stacked", label: "Stacked" },
      { value: "side-by-side", label: "Side by side" },
    ],
    keywords: ["split", "horizontal", "vertical", "pane"],
  },
  // ---------------------------------------------------------------- editor
  {
    key: "editor.fontSize",
    category: "editor",
    label: "Code font size",
    description: "Font size in code editors, the URL bar and key/value tables.",
    type: "number",
    scope: "browser",
    default: 12.5,
    min: 10,
    max: 20,
    step: 0.5,
    unit: "px",
    keywords: ["monospace", "text size"],
  },
  {
    key: "editor.fontFamily",
    category: "editor",
    label: "Code font",
    description:
      "Monospace font for code. Fonts must be installed on this computer; otherwise the default is used.",
    type: "select",
    scope: "browser",
    default: "default",
    options: [
      { value: "default", label: "System monospace" },
      { value: "jetbrains", label: "JetBrains Mono" },
      { value: "fira", label: "Fira Code" },
      { value: "cascadia", label: "Cascadia Code" },
      { value: "source", label: "Source Code Pro" },
      { value: "ibm", label: "IBM Plex Mono" },
      { value: "consolas", label: "Consolas" },
      { value: "menlo", label: "Menlo" },
    ],
    keywords: ["monospace", "typeface"],
  },
  {
    key: "editor.lineHeight",
    category: "editor",
    label: "Line height",
    description: "Spacing between lines in code editors.",
    type: "number",
    scope: "browser",
    default: 1.4,
    min: 1.1,
    max: 2,
    step: 0.1,
    keywords: ["line spacing"],
  },
  {
    key: "editor.lineNumbers",
    category: "editor",
    label: "Line numbers",
    description: "Show line numbers in code editors.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["gutter"],
  },
  {
    key: "editor.folding",
    category: "editor",
    label: "Code folding",
    description: "Show fold arrows to collapse JSON, XML and code blocks.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["collapse", "fold"],
  },
  {
    key: "editor.wrap",
    category: "editor",
    label: "Word wrap",
    description: "Wrap long lines in request body and script editors.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["wrap lines"],
  },
  {
    key: "editor.tabSize",
    category: "editor",
    label: "Tab size",
    description: "Spaces per indentation level.",
    type: "select",
    scope: "browser",
    default: "2",
    options: [
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "8", label: "8" },
    ],
    keywords: ["indent", "indentation", "spaces"],
  },
  {
    key: "editor.brackets",
    category: "editor",
    label: "Bracket matching & auto-close",
    description: "Highlight matching brackets and insert closing brackets and quotes as you type.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["autoclose", "parentheses", "braces"],
  },
  {
    key: "editor.activeLine",
    category: "editor",
    label: "Highlight active line",
    description: "Tint the line the cursor is on.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["cursor", "current line"],
  },
  {
    key: "editor.variableAutocomplete",
    category: "editor",
    label: "Variable autocomplete",
    description: "Suggest variables after typing {{ in inputs and editors.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["suggestions", "intellisense", "completion"],
  },
  {
    key: "editor.highlightUnresolved",
    category: "editor",
    label: "Highlight unresolved variables",
    description:
      "Underline {{variables}} that are not defined in the active environment, collection or globals.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["missing", "undefined", "red"],
  },

  // ---------------------------------------------------------------- requests
  {
    key: "requests.defaultMethod",
    category: "requests",
    label: "Default method",
    description: "HTTP method for new requests.",
    type: "select",
    scope: "browser",
    default: "GET",
    options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => ({
      value: m,
      label: m,
    })),
    keywords: ["verb"],
  },
  {
    key: "requests.defaultRawLanguage",
    category: "requests",
    label: "Default raw body language",
    description: "Language selected when you switch a request body to raw.",
    type: "select",
    scope: "browser",
    default: "json",
    options: [
      { value: "json", label: "JSON" },
      { value: "text", label: "Text" },
      { value: "xml", label: "XML" },
      { value: "html", label: "HTML" },
      { value: "javascript", label: "JavaScript" },
    ],
    keywords: ["body type", "content type"],
  },
  {
    key: "requests.timeoutMs",
    category: "requests",
    label: "Request timeout",
    description: "Timeout for new requests (each request can override it in its Settings tab).",
    type: "number",
    scope: "browser",
    default: 30000,
    min: 1000,
    max: 600000,
    step: 1000,
    unit: "ms",
    keywords: ["timeout"],
  },
  {
    key: "requests.followRedirects",
    category: "requests",
    label: "Follow redirects",
    description: "Follow HTTP 3xx responses by default for new requests.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["301", "302", "location"],
  },
  {
    key: "requests.maxRedirects",
    category: "requests",
    label: "Maximum redirects",
    description: "Stop following after this many hops (new requests).",
    type: "number",
    scope: "browser",
    default: 10,
    min: 0,
    max: 50,
    step: 1,
    keywords: ["hops"],
  },
  {
    key: "requests.verifySsl",
    category: "requests",
    label: "Verify SSL certificates",
    description: "Reject self-signed or invalid certificates by default for new requests.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["tls", "https", "self-signed", "certificate"],
  },
  {
    key: "requests.useCookieJar",
    category: "requests",
    label: "Use cookie jar",
    description: "Send and store cookies by default for new requests.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["cookies"],
  },
  {
    key: "requests.trimUrl",
    category: "requests",
    label: "Trim URL whitespace",
    description: "Remove leading and trailing spaces from the URL when sending.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["spaces"],
  },
  {
    key: "requests.curlPaste",
    category: "requests",
    label: "Import pasted cURL commands",
    description: "Pasting a cURL command into the URL bar fills in the whole request.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["curl", "paste", "import"],
  },

  // ---------------------------------------------------------------- responses
  {
    key: "responses.defaultView",
    category: "responses",
    label: "Default body view",
    description: "How response bodies open.",
    type: "select",
    scope: "browser",
    default: "pretty",
    options: [
      { value: "pretty", label: "Pretty" },
      { value: "raw", label: "Raw" },
      { value: "preview", label: "Preview" },
    ],
    keywords: ["format", "json"],
  },
  {
    key: "responses.wrap",
    category: "responses",
    label: "Word wrap",
    description: "Wrap long lines in the response body.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["wrap lines"],
  },
  {
    key: "responses.maxRenderKb",
    category: "responses",
    label: "Large response threshold",
    description:
      "Bodies larger than this show a truncated view first (you can still render the full body or download it).",
    type: "number",
    scope: "browser",
    default: 2048,
    min: 64,
    max: 51200,
    step: 64,
    unit: "KB",
    keywords: ["size", "performance", "big", "limit"],
  },
  {
    key: "responses.openTestsOnFailure",
    category: "responses",
    label: "Show test results on failure",
    description: "Switch to the Test Results tab automatically when a test fails.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["assertions", "tests"],
  },

  // ---------------------------------------------------------------- tabs
  {
    key: "tabs.previewOnClick",
    category: "tabs",
    label: "Preview tabs",
    description:
      "A single click in the sidebar opens a temporary preview tab that the next click replaces. Turn off to always open a permanent tab.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["single click", "italic"],
  },
  {
    key: "tabs.restore",
    category: "tabs",
    label: "Restore tabs on reload",
    description: "Reopen your tabs (including unsaved drafts) when the page is reloaded.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["session", "reopen"],
  },
  {
    key: "tabs.confirmCloseUnsaved",
    category: "tabs",
    label: "Confirm closing unsaved tabs",
    description: "Ask before closing a tab with unsaved changes.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["dirty", "warning", "discard"],
  },
  {
    key: "tabs.maxOpen",
    category: "tabs",
    label: "Maximum open tabs",
    description:
      "When exceeded, the oldest saved tabs are closed automatically (0 = unlimited). Unsaved tabs are never closed.",
    type: "number",
    scope: "browser",
    default: 0,
    min: 0,
    max: 50,
    step: 1,
    keywords: ["limit"],
  },

  // ---------------------------------------------------------------- variables
  {
    key: "variables.revealSecrets",
    category: "variables",
    label: "Show secret values",
    description: "Display secret variable values in variable tables instead of masking them.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["mask", "password", "reveal"],
  },
  {
    key: "variables.tooltips",
    category: "variables",
    label: "Variable value tooltips",
    description:
      "Show a variable's current value when hovering over {{variable}}. Secret values are always masked.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["hover"],
  },

  // ---------------------------------------------------------------- console
  {
    key: "console.maxEntries",
    category: "console",
    label: "Maximum entries",
    description: "Older console messages are dropped beyond this many.",
    type: "number",
    scope: "browser",
    default: 2000,
    min: 100,
    max: 20000,
    step: 100,
    keywords: ["log", "history"],
  },
  {
    key: "console.timestamps",
    category: "console",
    label: "Show timestamps",
    description: "Show the time of each console message.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["time"],
  },
  {
    key: "console.openOnError",
    category: "console",
    label: "Open console on errors",
    description: "Open the console automatically when a script or request logs an error.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["script error"],
  },

  // ---------------------------------------------------------------- runner
  {
    key: "runner.delayMs",
    category: "runner",
    label: "Default delay between requests",
    description: "Initial delay when you open the runner.",
    type: "number",
    scope: "browser",
    default: 0,
    min: 0,
    max: 60000,
    step: 100,
    unit: "ms",
    keywords: ["wait", "pause"],
  },
  {
    key: "runner.stopOnFailure",
    category: "runner",
    label: "Stop on first failure",
    description: "Initial value of the runner's stop-on-failure option.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["bail"],
  },
  {
    key: "runner.persistVariables",
    category: "runner",
    label: "Persist variable changes",
    description: "Initial value of the runner's persist-variables option.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["environment", "save"],
  },
  {
    key: "runner.verifySsl",
    category: "runner",
    label: "Verify SSL certificates",
    description: "Initial value of the runner's SSL verification option.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["tls", "certificate"],
  },
  {
    key: "runner.reportFormat",
    category: "runner",
    label: "Preferred report format",
    description: "Shown first among the export buttons after a run.",
    type: "select",
    scope: "browser",
    default: "html",
    options: [
      { value: "html", label: "HTML" },
      { value: "junit", label: "JUnit XML" },
      { value: "json", label: "JSON" },
    ],
    keywords: ["export", "junit", "report"],
  },
  {
    key: "execution.defaultHeaders",
    category: "execution",
    label: "Default headers",
    description:
      "Added to every request, including the runner, schedules, MCP and pm.sendRequest. Collection, folder and request headers with the same name win.",
    type: "keyvalue",
    scope: "server",
    default: [],
    maxRows: 50,
    keywords: ["global", "header"],
  },
  {
    key: "execution.userAgent",
    category: "execution",
    label: "User-Agent",
    description: "Sent when a request does not set its own User-Agent header. Leave empty to send none.",
    type: "text",
    scope: "server",
    default: "Postbox/0.1",
    maxLength: 256,
    placeholder: "No User-Agent header",
    keywords: ["ua", "agent", "header"],
  },
  {
    key: "execution.autoAcceptHeaders",
    category: "execution",
    label: "Add Accept headers automatically",
    description: "Send Accept: */* and Accept-Encoding: gzip, deflate, br when a request does not set them.",
    type: "boolean",
    scope: "server",
    default: true,
    keywords: ["accept", "encoding", "gzip", "compression"],
  },
  {
    key: "execution.scriptTimeoutMs",
    category: "execution",
    label: "Script time limit",
    description: "Maximum run time of each pre-request or test script.",
    type: "number",
    scope: "server",
    env: "SCRIPT_TIMEOUT_MS",
    default: 5000,
    min: 100,
    max: 60000,
    step: 100,
    unit: "ms",
    keywords: ["timeout", "sandbox", "script"],
  },
  {
    key: "execution.scriptMemoryMb",
    category: "execution",
    label: "Script memory limit",
    description: "Maximum memory of each script sandbox.",
    type: "number",
    scope: "server",
    env: "SCRIPT_MEMORY_MB",
    default: 32,
    min: 8,
    max: 512,
    step: 8,
    unit: "MB",
    keywords: ["memory", "sandbox", "script"],
  },
  {
    key: "execution.maxActiveRuns",
    category: "execution",
    label: "Concurrent collection runs",
    description:
      "How many collection runs (manual, API, MCP and scheduled) execute at the same time. Further runs wait in a queue.",
    type: "number",
    scope: "server",
    env: "RUNS_MAX_ACTIVE",
    default: 4,
    min: 1,
    max: 32,
    keywords: ["runner", "queue", "parallel", "concurrency"],
  },
  {
    key: "execution.maxQueuedRuns",
    category: "execution",
    label: "Queued collection runs",
    description: "How many runs may wait for a free slot. When the queue is full, new runs are rejected.",
    type: "number",
    scope: "server",
    env: "RUNS_MAX_QUEUED",
    default: 20,
    min: 0,
    max: 500,
    keywords: ["runner", "queue", "backlog"],
  },

  // ---------------------------------------------------------------- history & data
  {
    key: "history.limit",
    category: "data",
    label: "History entries per workspace",
    description: "Older entries are removed once a workspace has more than this many.",
    type: "number",
    scope: "server",
    env: "HISTORY_LIMIT",
    default: 500,
    min: 10,
    max: 20000,
    step: 10,
    keywords: ["history", "retention", "limit"],
  },
  {
    key: "history.retentionDays",
    category: "data",
    label: "Keep history for",
    description:
      "Remove history entries older than this many days. 0 keeps them until the entry limit is reached.",
    type: "number",
    scope: "server",
    default: 0,
    min: 0,
    max: 3650,
    unit: "days",
    keywords: ["history", "retention", "expire", "delete"],
  },
  {
    key: "history.skipSecrets",
    category: "data",
    label: "Skip history for requests that use secrets",
    description:
      "Do not record a request in history when its sent URL, headers or body contain a secret variable or credential value.",
    type: "boolean",
    scope: "server",
    default: false,
    keywords: ["history", "secret", "privacy"],
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function defaultValues(defs: SettingDef[] = SETTINGS): Record<string, SettingValue> {
  return Object.fromEntries(defs.map((d) => [d.key, d.default]));
}

/** Returns the validated value or throws with a readable message. */
export function validateSetting(def: SettingDef, value: unknown): SettingValue {
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${def.label} must be true or false`);
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${def.label} must be a number`);
      if (value < def.min || value > def.max)
        throw new Error(`${def.label} must be between ${def.min} and ${def.max}`);
      return value;
    }
    case "select":
      if (typeof value !== "string" || !def.options.some((o) => o.value === value))
        throw new Error(`${def.label} must be one of: ${def.options.map((o) => o.value).join(", ")}`);
      return value;
    case "accent":
      if (typeof value !== "string" || !isValidAccent(value))
        throw new Error(`${def.label} must be a preset name or a #rrggbb color`);
      return value.startsWith("#") ? value.toLowerCase() : value;
    case "text":
      if (typeof value !== "string") throw new Error(`${def.label} must be text`);
      if (value.length > def.maxLength)
        throw new Error(`${def.label} must be at most ${def.maxLength} characters`);
      // Header values cannot carry line breaks or other control characters.
      if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${def.label} contains control characters`);
      return value.trim();
    case "keyvalue": {
      if (!Array.isArray(value)) throw new Error(`${def.label} must be a list`);
      if (value.length > def.maxRows) throw new Error(`${def.label} allows at most ${def.maxRows} rows`);
      return value.map((row, i) => {
        const r = row as Partial<HeaderRow> | null;
        if (!r || typeof r.key !== "string" || typeof (r.value ?? "") !== "string")
          throw new Error(`${def.label} row ${i + 1} must have a text key and value`);
        const key = r.key.trim();
        const val = r.value ?? "";
        if (key && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))
          throw new Error(`${def.label} row ${i + 1}: "${key}" is not a valid header name`);
        if (/[\r\n\u0000]/.test(val))
          throw new Error(`${def.label} row ${i + 1}: value contains line breaks`);
        return { key, value: val, enabled: r.enabled !== false };
      });
    }
  }
}

/** Effective values with precedence: environment variable > saved value > default. */
export function resolveSettings(
  saved: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  defs: SettingDef[] = SETTINGS,
): { values: Record<string, SettingValue>; envLocked: Record<string, string> } {
  const values: Record<string, SettingValue> = {};
  const envLocked: Record<string, string> = {};
  for (const def of defs) {
    let value: SettingValue = def.default;
    if (def.key in saved) {
      try {
        value = validateSetting(def, saved[def.key]);
      } catch {
        /* ignore stale/invalid saved values */
      }
    }
    const raw = def.env ? env[def.env] : undefined;
    if (raw !== undefined && raw !== "") {
      try {
        // Numeric env pins outside the allowed range are clamped rather than ignored.
        const parsed =
          def.type === "number"
            ? Math.min(def.max, Math.max(def.min, Number(raw)))
            : def.type === "boolean"
              ? /^(1|true|yes|on)$/i.test(raw)
              : raw;
        value = validateSetting(def, parsed);
        envLocked[def.key] = def.env!;
      } catch {
        /* invalid env values fall back to the saved value */
      }
    }
    values[def.key] = value;
  }
  return { values, envLocked };
}

/** Keep only known keys with valid values (used for PATCH and import). Unknown keys are reported. */
export function sanitizeSettings(input: Record<string, unknown>): {
  valid: Record<string, SettingValue | null>;
  errors: string[];
} {
  const valid: Record<string, SettingValue | null> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      errors.push(`Unknown setting "${key}"`);
      continue;
    }
    if (value === null) {
      valid[key] = null;
      continue;
    }
    try {
      valid[key] = validateSetting(def, value);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { valid, errors };
}

/** Search across labels, descriptions, keywords and option labels. */
export function matchesQuery(def: SettingDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    def.label,
    def.description,
    def.key,
    ...(def.keywords ?? []),
    ...(def.type === "select" ? def.options.map((o) => o.label) : []),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Browser preferences are private to an account; server settings remain instance-wide. */
export const BROWSER_SETTING_KEYS = SETTINGS.filter((def) => def.scope === "browser").map((def) => def.key);
