/** SoapUI XML project migration. Source scripts and assertions are never executed. */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  DEFAULT_SETTINGS,
  type AuthConfig,
  type BodyConfig,
  type FolderNode,
  type KeyValue,
  type RequestNode,
  type Variable,
} from "../types";

type Xml = Record<string, unknown>;
const object = (v: unknown): Xml => (v && typeof v === "object" && !Array.isArray(v) ? (v as Xml) : {});
const list = (v: unknown): Xml[] =>
  (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]).map(object);
const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number"
      ? String(v)
      : v && typeof v === "object"
        ? text(object(v)["#text"])
        : "";
const attr = (v: Xml, key: string) => text(v[`@${key}`]);
const secretName =
  /password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|session[_-]?id|access[_-]?key/i;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_REQUESTS = 10_000;
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  maxNestedTags: 64,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: { enabled: true, maxTotalExpansions: 100_000, maxExpandedLength: MAX_BYTES },
} as const;

export interface SoapUiDiagnostic {
  code: string;
  path: string;
  message: string;
}
export interface SoapUiCounts {
  interfaces: number;
  endpoints: number;
  resources: number;
  testSuites: number;
  testCases: number;
  requestDefinitions: number;
  requestTestSteps: number;
  convertedRequests: number;
  skippedRequests: number;
  unsupportedTestSteps: number;
  assertions: number;
  scripts: number;
  attachments: number;
  properties: number;
}
export interface SoapUiImport {
  root: FolderNode;
  variables: Variable[];
  sourceCounts: SoapUiCounts;
  diagnostics: SoapUiDiagnostic[];
  warnings: string[];
}

export function isSoapUiXml(content: string): boolean {
  return /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?soapui-project(?=[\s/>])/.test(
    content,
  );
}

function parseXml(content: string): Xml {
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES)
    throw new Error("SoapUI XML exceeds the 10 MB import limit");
  const grammar = content.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(grammar))
    throw new Error("SoapUI imports do not allow DTDs or custom entities");
  if (/&(?!(?:amp|lt|gt|quot|apos);|#(?:\d+|x[\da-fA-F]+);)[A-Za-z_:][\w.:-]*;/.test(grammar))
    throw new Error("SoapUI imports do not allow unknown/custom entities");
  const valid = XMLValidator.validate(content);
  if (valid !== true) throw new Error(`Invalid SoapUI XML at line ${valid.err.line}: ${valid.err.msg}`);
  const parsed = object(new XMLParser(parserOptions).parse(content));
  let nodes = 0;
  const bound = (value: unknown, depth: number) => {
    if (depth > 64) throw new Error("SoapUI XML exceeds the nesting limit");
    if (Array.isArray(value)) {
      for (const child of value) bound(child, depth);
      return;
    }
    if (++nodes > MAX_NODES) throw new Error("SoapUI XML exceeds the element limit");
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        if (!key.startsWith("@") && key !== "#text") bound(child, depth + 1);
  };
  bound(parsed, 0);
  return parsed;
}

interface Scope {
  prefix: string;
  properties: Map<string, string>;
  parent?: Scope;
  project: Scope;
  suite?: Scope;
  testCase?: Scope;
  steps?: Map<string, Scope>;
}
interface RestMethod {
  service: Xml;
  node: Xml;
  path: string;
  parameters: Xml[];
}
const joinPath = (a: string, b: string) => `${a.replace(/\/$/, "")}/${b.replace(/^\//, "")}`;
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /%7B%7B(.*?)%7D%7D/gi,
    (_, name: string) => `{{${decodeURIComponent(name)}}}`,
  );

export function importSoapUi(content: string, options: { includeCredentials?: boolean } = {}): SoapUiImport {
  const parsed = parseXml(content);
  if (!Object.hasOwn(parsed, "soapui-project")) throw new Error("XML does not contain a SoapUI project");
  const project = object(parsed["soapui-project"]);
  const variables: Variable[] = [];
  const diagnostics: SoapUiDiagnostic[] = [];
  const counts: SoapUiCounts = {
    interfaces: 0,
    endpoints: 0,
    resources: 0,
    testSuites: 0,
    testCases: 0,
    requestDefinitions: 0,
    requestTestSteps: 0,
    convertedRequests: 0,
    skippedRequests: 0,
    unsupportedTestSteps: 0,
    assertions: 0,
    scripts: 0,
    attachments: 0,
    properties: 0,
  };
  const seen = new Set<string>();
  let diagnosticsTruncated = false;
  let serial = 0,
    secrets = 0;
  const id = () => `soapui-${++serial}`;
  const warn = (code: string, path: string, message: string) => {
    path = path.slice(0, 240);
    message = message.slice(0, 1000);
    const key = `${code}:${path}:${message}`;
    if (!seen.has(key)) {
      if (diagnostics.length >= 500) {
        diagnosticsTruncated = true;
        return;
      }
      seen.add(key);
      diagnostics.push({ code, path, message });
    }
  };
  const safePath = (value: string) => value.slice(0, 240);
  const folder = (name: string, root = false): FolderNode => ({
    kind: "folder",
    id: id(),
    name,
    auth: { type: root ? "none" : "inherit" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    children: [],
  });
  const root = folder(attr(project, "name") || "SoapUI project", true);
  if (text(project.description)) root.description = text(project.description);
  const variableKeys = new Set<string>();
  const variableByKey = new Map<string, Variable>();
  const keySuffixes = new Map<string, number>();
  const addVariable = (suggested: string, value: string, secret: boolean) => {
    let key = suggested || "property",
      suffix = keySuffixes.get(suggested) ?? 1;
    while (variableKeys.has(key)) key = `${suggested}_${++suffix}`;
    variableKeys.add(key);
    keySuffixes.set(suggested, suffix);
    const variable: Variable = {
      key,
      value: secret && !options.includeCredentials ? "" : value,
      type: secret ? "secret" : "default",
      enabled: true,
    };
    variables.push(variable);
    variableByKey.set(key, variable);
    if (secret && value && !options.includeCredentials) secrets++;
    return key;
  };
  const projectScope: Scope = { prefix: "", properties: new Map(), project: undefined! };
  projectScope.project = projectScope;
  const propertyList = (node: Xml) => list(object(node.properties).property);
  const declare = (node: Xml, scope: Scope) => {
    for (const p of propertyList(node)) {
      const name = text(p.name) || attr(p, "name");
      if (!name) continue;
      counts.properties++;
      scope.properties.set(
        name,
        addVariable(
          scope.prefix + name,
          text(p.value),
          secretName.test(name) || attr(p, "type").toLowerCase() === "password",
        ),
      );
    }
  };
  const template = (input: string, scope: Scope, path: string): string =>
    input.replace(/\$\{([^{}]*)\}/g, (whole, expression: string) => {
      let source: Scope | undefined,
        name = expression;
      const scoped = /^#(Project|TestSuite|TestCase)#([^#]+)$/.exec(expression);
      if (scoped) {
        source =
          scoped[1] === "Project" ? scope.project : scoped[1] === "TestSuite" ? scope.suite : scope.testCase;
        name = scoped[2];
      } else if (!expression.includes("#") && !expression.startsWith("=")) {
        source = scope;
        while (source && !source.properties.has(name)) source = source.parent;
      } else {
        const step = /^([^#]+)#([^#]+)$/.exec(expression);
        if (step) {
          source = scope.steps?.get(step[1]);
          name = step[2];
        }
      }
      const key = source?.properties.get(name);
      if (key) return `{{${key}}}`;
      warn(
        "unsupported-property",
        path,
        "An unresolved property expansion was preserved. External, XPath and Groovy property expressions are not evaluated.",
      );
      return whole;
    });
  declare(project, projectScope);
  // Declare every property before resolving values so forward references work.
  const suiteScopes = new Map<Xml, Scope>(),
    caseScopes = new Map<Xml, Scope>(),
    stepScopes = new Map<Xml, Scope>();
  list(project.testSuite).forEach((suite, si) => {
    const scope: Scope = {
      prefix: `suite_${si + 1}.`,
      properties: new Map(),
      parent: projectScope,
      project: projectScope,
    };
    scope.suite = scope;
    suiteScopes.set(suite, scope);
    declare(suite, scope);
    list(suite.testCase).forEach((testCase, ci) => {
      const local: Scope = {
        prefix: `suite_${si + 1}.case_${ci + 1}.`,
        properties: new Map(),
        parent: scope,
        project: projectScope,
        suite: scope,
        steps: new Map(),
      };
      local.testCase = local;
      caseScopes.set(testCase, local);
      declare(testCase, local);
      list(testCase.testStep).forEach((step, ti) => {
        if (attr(step, "type").toLowerCase() !== "properties") return;
        const stepScope: Scope = {
          ...local,
          prefix: `${local.prefix}step_${ti + 1}.`,
          properties: new Map(),
          parent: local,
        };
        declare(object(step.config), stepScope);
        local.steps!.set(attr(step, "name"), stepScope);
        stepScopes.set(step, stepScope);
      });
    });
  });
  for (const scope of [projectScope, ...suiteScopes.values(), ...caseScopes.values(), ...stepScopes.values()])
    for (const key of scope.properties.values()) {
      const variable = variableByKey.get(key)!;
      variable.value = template(variable.value, scope, root.name);
    }
  const inspect = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => inspect(child, `${path}/${index + 1}`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@") || key === "#text") continue;
      const n = Array.isArray(value) ? value.length : 1;
      if (key === "assertion") {
        counts.assertions += n;
        warn(
          "unsupported-assertion",
          safePath(path),
          "SoapUI assertions were not converted or executed. Recreate tests in Postbox.",
        );
      }
      if (
        /^(?:script|setupScript|tearDownScript|beforeRunScript|afterRunScript|startScript|stopScript|eventHandler)$/.test(
          key,
        )
      ) {
        const scripts = (Array.isArray(value) ? value : [value]).filter((v) => text(v).trim());
        counts.scripts += scripts.length;
        if (scripts.length)
          warn("unsupported-script", safePath(path), "Source scripts were not imported or executed.");
      }
      if (key === "attachment") {
        counts.attachments += n;
        warn(
          "unsupported-attachment",
          safePath(path),
          "Attachments are not embedded by this migration. Add files in Postbox before sending.",
        );
      }
      if (/^(?:mockService|restMockService|loadTest|securityTest)$/.test(key))
        warn("unsupported-feature", safePath(path), `${key} configuration was not imported.`);
      inspect(value, `${path}/${key}`);
    }
  };
  inspect(project, root.name);
  const credential = (value: string, path: string, field: string) => {
    if (!value) return "";
    const converted = template(value, projectScope, path);
    for (const reference of converted.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const variable = variableByKey.get(reference[1]);
      if (variable) {
        variable.type = "secret";
        if (!options.includeCredentials && variable.value) {
          variable.value = "";
          secrets++;
        }
      }
    }
    if (/^\{\{[^{}]+\}\}$/.test(converted)) return converted;
    return `{{${addVariable(`auth_${++serial}.${field}`, value, true)}}}`;
  };
  const auth = (node: Xml, scope: Scope, path: string): AuthConfig => {
    const creds = object(node.credentials),
      kind = text(creds.authType).toLowerCase();
    if (attr(node, "authProfile") || text(node.authProfile) || text(node.oauth2Profile))
      warn(
        "unsupported-auth",
        path,
        "Referenced authorization profiles require configuring authentication in Postbox.",
      );
    const username = template(text(creds.username), scope, path),
      password = template(text(creds.password), scope, path);
    if (
      attr(node, "outgoingWss") ||
      attr(node, "incomingWss") ||
      attr(node, "wssPasswordType") ||
      attr(node, "useWsAddressing") === "true" ||
      attr(node, "useWsReliableMessaging") === "true"
    )
      warn(
        "unsupported-soap-security",
        path,
        "WS-Security, addressing and reliable messaging configuration is not executed by the migration.",
      );
    if (/basic|preemptive/.test(kind))
      return {
        type: "basic",
        basic: {
          username: credential(username, path, "username"),
          password: credential(password, path, "password"),
        },
      };
    if (/digest/.test(kind))
      return {
        type: "digest",
        digest: {
          username: credential(username, path, "username"),
          password: credential(password, path, "password"),
        },
      };
    if (/ntlm/.test(kind))
      return {
        type: "ntlm",
        ntlm: {
          username: credential(username, path, "username"),
          password: credential(password, path, "password"),
          domain: template(text(creds.domain), scope, path),
          workstation: template(text(creds.workstation), scope, path),
        },
      };
    if (/bearer/.test(kind))
      return {
        type: "bearer",
        bearer: {
          token: credential(
            template(text(creds.token) || text(creds.accessToken), scope, path),
            path,
            "token",
          ),
        },
      };
    if ((username || password) && !kind.includes("no authorization"))
      warn(
        "unsupported-auth",
        path,
        "Credentials depend on source/global authentication settings. Configure authentication in Postbox.",
      );
    if (kind && !/global|none|no authorization/.test(kind))
      warn(
        "unsupported-auth",
        path,
        "This source authentication profile is not supported. Configure authentication in Postbox.",
      );
    return { type: "inherit" };
  };
  const header = (key: string, value: string, scope: Scope, path: string): KeyValue => ({
    key,
    value: secretName.test(key)
      ? credential(template(value, scope, path), path, "header")
      : template(value, scope, path),
    enabled: true,
  });
  const headers = (node: Xml, scope: Scope, path: string): KeyValue[] => {
    const result: KeyValue[] = [];
    for (const setting of list(object(node.settings).setting)) {
      if (!/request-headers$/.test(attr(setting, "id"))) continue;
      try {
        const fragment = parseXml(text(setting));
        const source = object(fragment["xml-fragment"] ?? fragment);
        for (const entry of list(source.entry))
          result.push(
            header(
              attr(entry, "key") || text(entry.key),
              attr(entry, "value") || text(entry.value),
              scope,
              path,
            ),
          );
      } catch {
        warn(
          "invalid-headers",
          path,
          "The request header settings could not be decoded and were not imported.",
        );
      }
    }
    for (const entry of list(object(node.headers).entry))
      result.push(
        header(attr(entry, "key") || text(entry.key), attr(entry, "value") || text(entry.value), scope, path),
      );
    return result.filter((h) => h.key);
  };
  const interfaces = list(project.interface),
    serviceByName = new Map<string, Xml>(),
    endpointDefaults = new Map<Xml, string>();
  interfaces.forEach((service, index) => {
    counts.interfaces++;
    serviceByName.set(attr(service, "name"), service);
    if (attr(service, "id")) serviceByName.set(attr(service, "id"), service);
    const endpoints = Array.isArray(object(service.endpoints).endpoint)
      ? (object(service.endpoints).endpoint as unknown[])
      : object(service.endpoints).endpoint === undefined
        ? []
        : [object(service.endpoints).endpoint];
    endpoints.forEach((endpoint, ei) => {
      counts.endpoints++;
      let value = template(text(endpoint).trim(), projectScope, attr(service, "name"));
      if (!options.includeCredentials && /^https?:\/\/[^/@\s]+@/.test(value)) {
        value = value.replace(/^(https?:\/\/)[^/@\s]+@/, "$1");
        warn(
          "omitted-url-credentials",
          attr(service, "name"),
          "Credentials embedded in an endpoint URL were omitted.",
        );
        secrets++;
      }
      const key = addVariable(`endpoint_${index + 1}${ei ? `_${ei + 1}` : ""}`, value, false);
      if (!ei) endpointDefaults.set(service, `{{${key}}}`);
    });
    if (object(service.definitionCache).part)
      warn(
        "cached-definition",
        attr(service, "name"),
        "Cached service definitions are not imported or fetched; saved request messages are preserved.",
      );
  });
  const restMethods = new Map<string, RestMethod>();
  const parameters = (node: Xml) => list(object(node.parameters).parameter);
  const restKey = (service: Xml, path: string, name: string) => `${attr(service, "name")}\0${path}\0${name}`;
  const endpoint = (node: Xml, service: Xml, scope: Scope, path: string) => {
    let value = template(text(node.endpoint).trim(), scope, path) || endpointDefaults.get(service) || "";
    if (!options.includeCredentials && /^https?:\/\/[^/@\s]+@/.test(value)) {
      value = value.replace(/^(https?:\/\/)[^/@\s]+@/, "$1");
      secrets++;
      warn("omitted-url-credentials", path, "Credentials embedded in the request URL were omitted.");
    }
    return value;
  };
  const request = (
    parent: FolderNode,
    node: Xml,
    method: string,
    url: string,
    requestHeaders: KeyValue[],
    scope: Scope,
    path: string,
    name?: string,
  ) => {
    if (counts.convertedRequests >= MAX_REQUESTS)
      throw new Error("SoapUI project exceeds the 10000 request limit");
    if (!url || !/^(?:https?:\/\/|\{\{|\$\{)/i.test(url)) {
      counts.skippedRequests++;
      warn(
        "unsupported-endpoint",
        path,
        "Request was skipped because its HTTP endpoint is missing or unsupported.",
      );
      return;
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) {
      counts.skippedRequests++;
      warn("invalid-method", path, "Request was skipped because its HTTP method is invalid.");
      return;
    }
    const sourceBody = node.request;
    if (
      sourceBody &&
      typeof sourceBody === "object" &&
      Object.keys(object(sourceBody)).some((k) => k !== "#text" && !k.startsWith("@"))
    ) {
      counts.skippedRequests++;
      warn(
        "unsupported-body",
        path,
        "Request was skipped because its message is not serialized text or CDATA.",
      );
      return;
    }
    const effectiveAuth = auth(node, scope, path);
    let payload = template(text(sourceBody), scope, path);
    const media = attr(node, "mediaType") || text(node.mediaType);
    if (media && !requestHeaders.some((h) => h.key.toLowerCase() === "content-type"))
      requestHeaders.push(header("Content-Type", media, scope, path));
    // Explicit payload credentials can also occur in otherwise ordinary requests.
    // Move recognized password/token fields into secret variables without executing the payload.
    payload = payload
      .replace(
        /("(?:password|passwd|secret|access_token|api_key)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi,
        (_, start: string, value: string, end: string) => {
          if (value && !value.includes("{{") && !value.includes("${")) {
            return start + credential(value, path, "body") + end;
          }
          return start + value + end;
        },
      )
      .replace(
        /(<(?:[\w.-]+:)?(?:Password|Token|Secret)\b[^>]*>)([^<]+)(<\/[^>]+>)/gi,
        (_, start: string, value: string, end: string) => {
          if (value && !value.includes("{{") && !value.includes("${")) {
            return start + credential(value, path, "body") + end;
          }
          return start + value + end;
        },
      );
    const body: BodyConfig = payload
      ? {
          mode: "raw",
          raw: payload,
          language: /json/i.test(media) ? "json" : /xml|soap/i.test(media) ? "xml" : "text",
        }
      : { mode: "none" };
    const result: RequestNode = {
      kind: "request",
      id: id(),
      name: name || attr(node, "name") || method,
      method: method.toUpperCase(),
      url,
      params: Array.from(new URLSearchParams(url.split("?")[1]?.split("#")[0] ?? ""), ([key, value]) => ({
        key,
        value,
        enabled: true,
      })),
      headers: requestHeaders,
      body,
      auth: effectiveAuth,
      preRequestScript: "",
      testScript: "",
      settings: { ...DEFAULT_SETTINGS },
    };
    const timeout = attr(node, "timeout");
    if (/^\d+$/.test(timeout) && Number(timeout) > 0)
      result.settings.timeoutMs = Math.min(Number(timeout), 3_600_000);
    if (text(node.description)) result.description = text(node.description);
    parent.children.push(result);
    counts.convertedRequests++;
  };
  const soap = (
    parent: FolderNode,
    node: Xml,
    service: Xml,
    operation: Xml,
    scope: Scope,
    path: string,
    name?: string,
  ) => {
    const resultHeaders = headers(node, scope, path),
      action = template(attr(operation, "action"), scope, path);
    const version = attr(service, "soapVersion");
    const is12 =
      version === "1_2" ||
      version === "1.2" ||
      text(node.request).includes("http://www.w3.org/2003/05/soap-envelope");
    if (!resultHeaders.some((h) => h.key.toLowerCase() === "content-type"))
      resultHeaders.push(
        header(
          "Content-Type",
          is12
            ? `application/soap+xml; charset=utf-8${action ? `; action="${action.replaceAll('"', "%22")}"` : ""}`
            : "text/xml; charset=utf-8",
          scope,
          path,
        ),
      );
    if (!is12 && action && !resultHeaders.some((h) => h.key.toLowerCase() === "soapaction"))
      resultHeaders.push(header("SOAPAction", `"${action}"`, scope, path));
    request(
      parent,
      { ...node, "@mediaType": is12 ? "application/soap+xml" : "text/xml" },
      "POST",
      endpoint(node, service, scope, path),
      resultHeaders,
      scope,
      path,
      name,
    );
  };
  const rest = (
    parent: FolderNode,
    node: Xml,
    definition: RestMethod,
    scope: Scope,
    path: string,
    name?: string,
  ) => {
    const values = new Map<string, string>();
    for (const entry of list(object(node.parameters).entry))
      values.set(attr(entry, "key"), attr(entry, "value") || text(entry));
    let route = definition.path;
    const query: string[] = [],
      requestHeaders = headers(node, scope, path);
    for (const parameter of definition.parameters) {
      const key = text(parameter.name) || attr(parameter, "name");
      if (!key) continue;
      let value = template(
        values.has(key) ? values.get(key)! : text(parameter.value) || text(parameter.default),
        scope,
        path,
      );
      const style = (text(parameter.style) || attr(parameter, "style") || "QUERY").toUpperCase();
      if (secretName.test(key)) value = credential(value, path, "parameter");
      if (style === "TEMPLATE") route = route.replaceAll(`{${key}}`, encode(value));
      else if (style === "QUERY") {
        if (value || text(parameter.required) === "true" || values.has(key))
          query.push(`${encode(key)}=${encode(value)}`);
      } else if (style === "HEADER") requestHeaders.push(header(key, value, scope, path));
      else warn("unsupported-parameter", path, `A ${style} parameter was not imported.`);
      values.delete(key);
    }
    for (const [key, value] of values)
      query.push(
        `${encode(key)}=${encode(secretName.test(key) ? credential(template(value, scope, path), path, "parameter") : template(value, scope, path))}`,
      );
    route = template(route, scope, path);
    let url = joinPath(endpoint(node, definition.service, scope, path), route);
    if (query.length) url += (url.includes("?") ? "&" : "?") + query.join("&");
    request(
      parent,
      node,
      attr(definition.node, "method") || text(definition.node.method) || "GET",
      url,
      requestHeaders,
      scope,
      path,
      name,
    );
  };
  const resources = (parent: FolderNode, service: Xml, node: Xml, parentPath: string, inherited: Xml[]) => {
    counts.resources++;
    const path = joinPath(parentPath, attr(node, "path"));
    const target = folder(attr(node, "name") || attr(node, "path") || "Resource");
    parent.children.push(target);
    const combined = [...inherited, ...parameters(node)];
    for (const method of list(node.method)) {
      const merged = new Map<string, Xml>();
      for (const p of [...combined, ...parameters(method)]) merged.set(text(p.name) || attr(p, "name"), p);
      const definition: RestMethod = { service, node: method, path, parameters: [...merged.values()] };
      restMethods.set(restKey(service, path, attr(method, "name")), definition);
      for (const req of list(method.request)) {
        counts.requestDefinitions++;
        rest(target, req, definition, projectScope, `${attr(service, "name")}${path}/${attr(req, "name")}`);
      }
    }
    for (const child of list(node.resource)) resources(target, service, child, path, combined);
  };
  for (const service of interfaces) {
    const target = folder(attr(service, "name") || "Service");
    root.children.push(target);
    target.auth = auth(service, projectScope, target.name);
    const kind = attr(service, "type").toLowerCase();
    if (kind === "rest" || kind.endsWith(":restservice"))
      for (const resource of list(service.resource))
        resources(target, service, resource, attr(service, "basePath"), parameters(service));
    else if (kind === "wsdl" || kind.endsWith(":wsdlinterface"))
      for (const operation of list(service.operation)) {
        const operationFolder = folder(attr(operation, "name") || "Operation");
        target.children.push(operationFolder);
        for (const call of list(operation.call)) {
          counts.requestDefinitions++;
          soap(
            operationFolder,
            call,
            service,
            operation,
            projectScope,
            `${target.name}/${operationFolder.name}/${attr(call, "name")}`,
          );
        }
      }
    else warn("unsupported-interface", target.name, "This interface type is not supported by the migration.");
  }
  for (const suite of list(project.testSuite)) {
    counts.testSuites++;
    const suiteFolder = folder(attr(suite, "name") || "Test suite");
    root.children.push(suiteFolder);
    for (const testCase of list(suite.testCase)) {
      counts.testCases++;
      const caseFolder = folder(attr(testCase, "name") || "Test case");
      suiteFolder.children.push(caseFolder);
      const scope = caseScopes.get(testCase)!;
      for (const step of list(testCase.testStep)) {
        const kind = attr(step, "type").toLowerCase(),
          config = object(step.config),
          path = `${suiteFolder.name}/${caseFolder.name}/${attr(step, "name")}`;
        if (attr(step, "disabled") === "true") {
          if (["request", "restrequest", "httprequest"].includes(kind)) {
            counts.requestTestSteps++;
            counts.skippedRequests++;
          }
          counts.unsupportedTestSteps++;
          warn("disabled-step", path, "Disabled source step was not imported.");
          continue;
        }
        if (kind === "request") {
          counts.requestTestSteps++;
          const service = serviceByName.get(text(config.interface)) ?? {};
          const operation =
            list(service.operation).find(
              (o) =>
                attr(o, "name") === text(config.operation) ||
                attr(o, "bindingOperationName") === text(config.operation),
            ) ?? {};
          if (!Object.keys(service).length || !Object.keys(operation).length)
            warn(
              "missing-service-reference",
              path,
              "SOAP service/operation reference was not found. Saved endpoint/message are imported without inferred action metadata.",
            );
          soap(caseFolder, object(config.request), service, operation, scope, path, attr(step, "name"));
        } else if (kind === "restrequest") {
          counts.requestTestSteps++;
          const service = serviceByName.get(attr(config, "service")),
            definition =
              service &&
              restMethods.get(restKey(service, attr(config, "resourcePath"), attr(config, "methodName")));
          if (!definition) {
            counts.skippedRequests++;
            warn(
              "missing-service-reference",
              path,
              "REST request was skipped because its service/resource/method definition was not found.",
            );
            continue;
          }
          rest(caseFolder, object(config.restRequest), definition, scope, path, attr(step, "name"));
        } else if (kind === "httprequest") {
          counts.requestTestSteps++;
          request(
            caseFolder,
            config,
            attr(config, "method") || text(config.method) || "GET",
            template(text(config.endpoint), scope, path),
            headers(config, scope, path),
            scope,
            path,
            attr(step, "name"),
          );
        } else if (kind !== "properties") {
          counts.unsupportedTestSteps++;
          warn(
            "unsupported-step",
            path,
            `Source ${kind || "unknown"} test step was not imported or executed.`,
          );
        }
      }
    }
  }
  if (secrets)
    warn(
      "credentials-omitted",
      root.name,
      `${secrets} recognized credential/secret fields were omitted. Fill secret variables in Postbox or explicitly include credentials before importing.`,
    );
  if (!counts.convertedRequests)
    warn(
      "no-requests",
      root.name,
      "No runnable HTTP requests were found. Review source counts and diagnostics before importing.",
    );
  warn(
    "migration-review",
    root.name,
    "Imported request snapshots require review. Source assertions, scripts and workflow semantics are not equivalent to Postbox tests; inline payloads can contain unrecognized secrets.",
  );
  if (diagnosticsTruncated)
    diagnostics[499] = {
      code: "diagnostics-truncated",
      path: root.name.slice(0, 240),
      message: "Additional migration diagnostics were omitted after the 500-entry limit.",
    };
  return {
    root,
    variables,
    sourceCounts: counts,
    diagnostics,
    warnings: diagnostics.map((d) => `${d.path}: ${d.message}`),
  };
}
