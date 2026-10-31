/**
 * Insomnia export migration (v4 JSON/YAML resource exports and v5 collection
 * YAML). Template tags and plugins are never evaluated: they are left as text and
 * reported, and Insomnia scripts are imported commented out.
 */
import { z } from "zod";
import type {
  AuthConfig,
  BodyConfig,
  FolderNode,
  FormDataField,
  KeyValue,
  RawLanguage,
  RequestNode,
  TreeNode,
  Variable,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";

type Data = Record<string, unknown>;
const isData = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Data => (isData(v) ? v : {});
const list = (v: unknown): Data[] => (Array.isArray(v) ? v.filter(isData) : []);
const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_RESOURCES = 20000;

export function isInsomnia(value: unknown): boolean {
  if (!isData(value)) return false;
  if (value._type === "export" && Array.isArray(value.resources)) return true;
  return typeof value.type === "string" && /^collection\.insomnia\.rest\/5\./.test(value.type);
}

export interface InsomniaImport {
  collections: { root: FolderNode; variables: Variable[] }[];
  environments: { name: string; variables: Variable[] }[];
  warnings: string[];
}

/** Common shape for v4 resources and v5 collection items. */
interface Item {
  id: string;
  kind: "folder" | "request" | "unsupported";
  type: string;
  name: string;
  sort: number;
  data: Data;
  children: Item[];
}

interface EnvTree {
  name: string;
  data: Data;
  children: { name: string; data: Data }[];
}

export function importInsomnia(
  value: unknown,
  options: { includeCredentials?: boolean } = {},
): InsomniaImport {
  if (!options.includeCredentials)
    throw new Error(
      "Insomnia exports may contain credentials. Explicitly enable includeCredentials to import them.",
    );
  if (!isInsomnia(value)) throw new Error("Not an Insomnia export.");
  const source = value as Data;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (!warned.has(message) && warnings.length < 200) {
      warned.add(message);
      warnings.push(message);
    }
  };

  /** Insomnia {{ _.a.b }} / {{ a }} references become {{a.b}}; tags and filters are reported. */
  const template = (input: string): string => {
    const out = input.replace(/\{\{\s*(?:_\.)?([A-Za-z_$][\w$.-]*)\s*\}\}/g, "{{$1}}");
    for (const m of out.matchAll(/\{%\s*([\w-]+)/g))
      warn(`Template tag "${m[1]}" is an Insomnia plugin feature and was left unresolved.`);
    if (/\{\{[^}]*\|/.test(out)) warn("Template filters (| ...) are not supported and were left unresolved.");
    return out;
  };

  /** Flatten nested environment data to dotted keys, as {{ _.a.b }} references expect. */
  const variables = (data: Data, prefix = "", out: Variable[] = []): Variable[] => {
    for (const [key, raw] of Object.entries(data)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (isData(raw)) variables(raw, name, out);
      else
        out.push({
          key: name,
          value: typeof raw === "string" ? template(raw) : JSON.stringify(raw ?? ""),
          type: "default",
          enabled: true,
        });
    }
    return out;
  };

  const { workspaces, envs } = source._type === "export" ? fromV4(source, warn) : fromV5(source, warn);

  const kv = (rows: unknown): KeyValue[] =>
    list(rows)
      .filter((r) => str(r.name) || str(r.value))
      .map((r) => ({
        key: template(str(r.name)),
        value: template(str(r.value)),
        enabled: r.disabled !== true,
      }));

  const scripts = (owner: string, pre: unknown, post: unknown) => {
    const comment = (code: string, phase: string) => {
      if (!code.trim()) return "";
      warn(
        `${owner}: Insomnia ${phase} scripts were imported commented out; translate insomnia.* calls to pm.* first.`,
      );
      return [
        `// Imported from Insomnia (${phase}); not translated or executed.`,
        ...code.split("\n").map((line) => `// ${line}`),
      ].join("\n");
    };
    return {
      preRequestScript: comment(str(pre), "pre-request"),
      testScript: comment(str(post), "after-response"),
    };
  };

  const auth = (owner: string, raw: unknown): AuthConfig => {
    const a = obj(raw);
    const type = str(a.type);
    if (!type) return { type: "inherit" };
    if (a.disabled === true || type === "none") return { type: "none" };
    const s = (k: string) => template(str(a[k]));
    switch (type) {
      case "inherit":
        return { type: "inherit" };
      case "basic":
        return { type: "basic", basic: { username: s("username"), password: s("password") } };
      case "digest":
        return { type: "digest", digest: { username: s("username"), password: s("password") } };
      case "bearer":
        return {
          type: "bearer",
          bearer: { token: s("token"), ...(s("prefix") ? { prefix: s("prefix") } : {}) },
        };
      case "apikey": {
        const addTo = str(a.addTo);
        if (addTo === "cookie") {
          warn(`${owner}: API key sent as a cookie was moved to a Cookie header.`);
          return {
            type: "apikey",
            apikey: { key: "Cookie", value: `${s("key")}=${s("value")}`, in: "header" },
          };
        }
        return {
          type: "apikey",
          apikey: { key: s("key"), value: s("value"), in: addTo === "queryParams" ? "query" : "header" },
        };
      }
      case "ntlm":
        return { type: "ntlm", ntlm: { username: s("username"), password: s("password") } };
      case "hawk":
        return {
          type: "hawk",
          hawk: {
            authId: s("id"),
            authKey: s("key"),
            algorithm: str(a.algorithm) === "sha1" ? "sha1" : "sha256",
            ...(s("ext") ? { ext: s("ext") } : {}),
            includePayloadHash: a.validatePayload === true,
          },
        };
      case "iam":
        return {
          type: "awsv4",
          awsv4: {
            accessKey: s("accessKeyId"),
            secretKey: s("secretAccessKey"),
            ...(s("sessionToken") ? { sessionToken: s("sessionToken") } : {}),
            region: s("region") || undefined,
            service: s("service"),
          },
        };
      case "asap":
        return {
          type: "asap",
          asap: {
            issuer: s("issuer"),
            ...(s("subject") ? { subject: s("subject") } : {}),
            audience: s("audience"),
            keyId: s("keyId"),
            privateKey: s("privateKey"),
            ...(s("additionalClaims") ? { additionalClaims: s("additionalClaims") } : {}),
          },
        };
      case "oauth1": {
        const method = str(a.signatureMethod);
        return {
          type: "oauth1",
          oauth1: {
            consumerKey: s("consumerKey"),
            consumerSecret: s("consumerSecret"),
            ...(s("tokenKey") ? { token: s("tokenKey") } : {}),
            ...(s("tokenSecret") ? { tokenSecret: s("tokenSecret") } : {}),
            signatureMethod:
              method === "RSA-SHA1" || method === "PLAINTEXT" || method === "HMAC-SHA256"
                ? method
                : "HMAC-SHA1",
            ...(s("privateKey") ? { privateKey: s("privateKey") } : {}),
            ...(s("callback") ? { callback: s("callback") } : {}),
            ...(s("verifier") ? { verifier: s("verifier") } : {}),
            ...(s("realm") ? { realm: s("realm") } : {}),
            ...(s("nonce") ? { nonce: s("nonce") } : {}),
            ...(s("timestamp") ? { timestamp: s("timestamp") } : {}),
            ...(str(a.version) ? { version: s("version") } : {}),
          },
        };
      }
      case "oauth2": {
        const grant = str(a.grantType);
        const supported =
          grant === "client_credentials" || grant === "password" || grant === "authorization_code";
        if (!supported)
          warn(
            `${owner}: OAuth 2.0 ${grant || "flow"} is not supported yet; paste a token into the manual access token.`,
          );
        return {
          type: "oauth2",
          oauth2: {
            grantType: supported ? grant : "manual",
            accessTokenUrl: s("accessTokenUrl"),
            clientId: s("clientId"),
            clientSecret: s("clientSecret"),
            scope: s("scope"),
            ...(grant === "password" ? { username: s("username"), password: s("password") } : {}),
            ...(grant === "authorization_code"
              ? {
                  authUrl: s("authorizationUrl"),
                  ...(s("redirectUrl") ? { redirectUri: s("redirectUrl") } : {}),
                  ...(a.usePkce === true ? {} : { usePkce: false }),
                  ...(str(a.pkceMethod) === "plain" ? { codeChallengeMethod: "plain" as const } : {}),
                }
              : {}),
            clientAuthentication: a.credentialsInBody === true ? "body" : "header",
            accessToken: "",
            headerPrefix: s("tokenPrefix") || "Bearer",
          },
        };
      }
      default:
        warn(`${owner}: "${type}" authentication is not supported and was disabled.`);
        return { type: "none" };
    }
  };

  const body = (owner: string, raw: unknown): BodyConfig => {
    const b = obj(raw);
    const mime = str(b.mimeType).split(";")[0].trim().toLowerCase();
    const text = template(str(b.text));
    if (mime === "application/x-www-form-urlencoded") return { mode: "urlencoded", urlencoded: kv(b.params) };
    if (mime === "multipart/form-data") {
      const fields: FormDataField[] = list(b.params).map((p) => {
        const base = { key: template(str(p.name)), value: "", enabled: p.disabled !== true };
        if (p.type !== "file") return { ...base, value: template(str(p.value)), type: "text" as const };
        warn(`${owner}: form-data file contents are not part of Insomnia exports; reselect the files.`);
        return {
          ...base,
          type: "file" as const,
          fileName: str(p.fileName).split(/[\\/]/).pop() ?? "",
          data: "",
          missing: true,
        };
      });
      return { mode: "formdata", formdata: fields };
    }
    if (mime === "application/graphql") {
      let parsed: Data = {};
      try {
        parsed = obj(JSON.parse(str(b.text) || "{}"));
      } catch {
        warn(`${owner}: GraphQL body was not valid JSON and was kept as the query text.`);
        parsed = { query: str(b.text) };
      }
      const vars = parsed.variables;
      return {
        mode: "graphql",
        graphql: {
          query: template(str(parsed.query)),
          variables: template(typeof vars === "string" ? vars : JSON.stringify(vars ?? {}, null, 2)),
          ...(str(parsed.operationName) ? { operationName: str(parsed.operationName) } : {}),
        },
      };
    }
    if (str(b.fileName) || mime === "application/octet-stream") {
      warn(`${owner}: binary body files are not part of Insomnia exports; reselect the file.`);
      return {
        mode: "binary",
        binary: {
          fileName: str(b.fileName).split(/[\\/]/).pop() ?? "",
          data: "",
          missing: true,
          ...(mime ? { contentType: mime } : {}),
        },
      };
    }
    if (!mime && !text) return { mode: "none" };
    const language: RawLanguage = /json/.test(mime)
      ? "json"
      : /xml/.test(mime)
        ? "xml"
        : /html/.test(mime)
          ? "html"
          : /javascript/.test(mime)
            ? "javascript"
            : "text";
    return { mode: "raw", raw: text, language };
  };

  const encodePart = (s: string) =>
    s
      .split(/(\{\{[^{}]+\}\})/)
      .map((p) => (p.startsWith("{{") ? p : encodeURIComponent(p)))
      .join("");

  const request = (item: Item): RequestNode => {
    const d = item.data;
    const method = (str(d.method) || "GET").toUpperCase();
    if (!METHOD.test(method)) throw new Error(`Insomnia request "${item.name}" has an invalid method.`);
    const params = kv(d.parameters);
    let url = template(str(d.url));
    const enabledParams = params.filter((p) => p.enabled);
    if (enabledParams.length) {
      const [base, hash] = url.split("#");
      const extra = enabledParams.map((p) => `${encodePart(p.key)}=${encodePart(p.value)}`).join("&");
      url = `${base}${base.includes("?") ? "&" : "?"}${extra}${hash !== undefined ? `#${hash}` : ""}`;
    }
    const settings = obj(d.settings);
    const follow = str(d.settingFollowRedirects || settings.followRedirects);
    const sendCookies = d.settingSendCookies ?? settings.sendCookies;
    if (d.settingEncodeUrl === false || settings.encodeUrl === false)
      warn(`${item.name}: "do not encode URL" was not migrated; Postbox sends URLs as written.`);
    const s = scripts(
      item.name,
      d.preRequestScript ?? obj(d.scripts).preRequest,
      d.afterResponseScript ?? obj(d.scripts).afterResponse,
    );
    return {
      kind: "request",
      id: item.id,
      name: item.name || url || "Request",
      method,
      url,
      params: [...enabledParams, ...params.filter((p) => !p.enabled)],
      headers: kv(d.headers),
      body: body(item.name, d.body),
      auth: auth(item.name, d.authentication),
      ...s,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(follow === "off" || follow === "false" ? { followRedirects: false } : {}),
        ...(sendCookies === false ? { useCookieJar: false } : {}),
      },
      description: str(d.description),
    };
  };

  const folder = (item: Item, isRoot = false): FolderNode => {
    const d = item.data;
    const s = scripts(
      item.name,
      d.preRequestScript ?? obj(d.scripts).preRequest,
      d.afterResponseScript ?? obj(d.scripts).afterResponse,
    );
    const env = isRoot ? [] : variables(obj(d.environment));
    let preRequestScript = s.preRequestScript;
    if (env.length) {
      // Postbox has no folder variables; folder scripts set them as local variables, which Insomnia's
      // folder environment also overrides.
      warn(`${item.name}: folder environment variables were converted to a folder pre-request script.`);
      const sets = env.map((v) => `pm.variables.set(${JSON.stringify(v.key)}, ${JSON.stringify(v.value)});`);
      preRequestScript = [`// Folder environment imported from Insomnia.`, ...sets, preRequestScript]
        .filter(Boolean)
        .join("\n");
    }
    const children: TreeNode[] = [];
    for (const child of [...item.children].sort((a, b) => a.sort - b.sort)) {
      if (child.kind === "folder") children.push(folder(child));
      else if (child.kind === "request") children.push(request(child));
      else warn(`${child.type} items are not supported yet and were skipped (for example "${child.name}").`);
    }
    return {
      kind: "folder",
      id: item.id,
      name: item.name || "Insomnia collection",
      description: str(d.description),
      auth: auth(item.name, d.authentication),
      headers: kv(d.headers),
      preRequestScript,
      testScript: s.testScript,
      children,
    };
  };

  const collections = workspaces.map((ws) => {
    const tree = envs.get(ws.id);
    return { root: folder(ws, true), variables: tree ? variables(tree.data) : [] };
  });
  const environments = [...envs.entries()].flatMap(([wsId, tree]) => {
    const prefix = workspaces.length > 1 ? `${workspaces.find((w) => w.id === wsId)?.name ?? ""} / ` : "";
    return tree.children.map((sub) => ({
      name: `${prefix}${sub.name || "Environment"}`,
      variables: variables(sub.data),
    }));
  });
  if (!collections.length) throw new Error("The Insomnia export contains no request collection.");
  return { collections, environments, warnings };
}

function fromV4(source: Data, warn: (m: string) => void) {
  const resources = list(source.resources);
  if (resources.length > MAX_RESOURCES)
    throw new Error(`Insomnia export exceeds ${MAX_RESOURCES} resources.`);
  const format = Number(source.__export_format);
  if (format !== 4)
    throw new Error(
      `Unsupported Insomnia export format ${str(source.__export_format) || "?"} (expected 4 or v5 YAML).`,
    );
  const byId = new Map<string, Item>();
  const parentOf = new Map<string, string>();
  for (const r of resources) {
    const id = z.string().min(1).parse(r._id);
    if (byId.has(id)) throw new Error(`Duplicate Insomnia resource ID ${id}.`);
    const type = str(r._type);
    const kind =
      type === "workspace" || type === "request_group"
        ? "folder"
        : type === "request"
          ? "request"
          : "unsupported";
    byId.set(id, {
      id,
      kind,
      type,
      name: str(r.name),
      sort: Number(r.metaSortKey) || 0,
      data: r,
      children: [],
    });
    parentOf.set(id, str(r.parentId));
  }
  const workspaces: Item[] = [];
  const envs = new Map<string, EnvTree>();
  const ignored = new Set([
    "cookie_jar",
    "api_spec",
    "environment",
    "proto_file",
    "proto_directory",
    "unit_test",
    "unit_test_suite",
  ]);
  for (const item of byId.values()) {
    if (item.type === "workspace") {
      workspaces.push(item);
      continue;
    }
    if (item.type === "environment") continue;
    if (ignored.has(item.type)) {
      warn(`Insomnia ${item.type} resources are not migrated.`);
      continue;
    }
    const parent = byId.get(parentOf.get(item.id) ?? "");
    if (!parent || parent.kind !== "folder") {
      warn(`"${item.name}" references a missing parent folder and was skipped.`);
      continue;
    }
    parent.children.push(item);
  }
  // Base environments belong to a workspace; sub-environments belong to a base environment.
  for (const item of byId.values()) {
    if (item.type !== "environment") continue;
    const parent = byId.get(parentOf.get(item.id) ?? "");
    if (parent?.type === "workspace") {
      const tree = envs.get(parent.id) ?? { name: item.name, data: {}, children: [] };
      tree.data = { ...tree.data, ...obj(item.data.data) };
      envs.set(parent.id, tree);
    }
  }
  for (const item of byId.values()) {
    if (item.type !== "environment") continue;
    const parent = byId.get(parentOf.get(item.id) ?? "");
    if (parent?.type !== "environment") continue;
    const wsId = parentOf.get(parent.id) ?? "";
    const tree = envs.get(wsId);
    if (!tree) {
      warn(`Environment "${item.name}" has no base environment and was skipped.`);
      continue;
    }
    tree.children.push({ name: item.name, data: obj(item.data.data) });
  }
  // Guard against parent cycles (a folder listed under its own descendant would never be reached).
  const reachable = new Set<string>();
  const walk = (item: Item, depth: number) => {
    if (depth > 100) throw new Error("Insomnia folders are nested too deeply.");
    reachable.add(item.id);
    for (const child of item.children) walk(child, depth + 1);
  };
  for (const ws of workspaces) walk(ws, 0);
  for (const item of byId.values())
    if ((item.kind === "request" || item.type === "request_group") && !reachable.has(item.id))
      warn(`"${item.name}" is not reachable from a workspace (parent cycle) and was skipped.`);
  return { workspaces, envs };
}

function fromV5(source: Data, warn: (m: string) => void) {
  if (source.cookieJar !== undefined) warn("Insomnia cookie jars are not migrated.");
  if (source.spec !== undefined) warn("Insomnia API design documents are not migrated.");
  let count = 0;
  const toItem = (raw: Data, depth: number): Item => {
    if (depth > 100) throw new Error("Insomnia folders are nested too deeply.");
    if (++count > MAX_RESOURCES) throw new Error(`Insomnia export exceeds ${MAX_RESOURCES} items.`);
    const id = str(obj(raw.meta).id) || `insomnia-${count}`;
    const isFolder = Array.isArray(raw.children) || id.startsWith("fld_");
    const isRequest =
      !isFolder &&
      (id.startsWith("req_") || (typeof raw.url === "string" && !/^(ws-req|greq|wrk)_/.test(id)));
    const type = isFolder ? "request_group" : isRequest ? "request" : id.split("_")[0] || "unknown";
    return {
      id,
      kind: isFolder ? "folder" : isRequest ? "request" : "unsupported",
      type,
      name: str(raw.name),
      sort: Number(obj(raw.meta).sortKey) || count,
      data: raw,
      children: isFolder ? list(raw.children).map((c) => toItem(c, depth + 1)) : [],
    };
  };
  const meta = obj(source.meta);
  const ws: Item = {
    id: str(meta.id) || "insomnia-root",
    kind: "folder",
    type: "workspace",
    name: str(source.name),
    sort: 0,
    data: { description: meta.description ?? source.description },
    children: list(source.collection).map((c) => toItem(c, 1)),
  };
  const envs = new Map<string, EnvTree>();
  const env = obj(source.environments);
  if (Object.keys(env).length)
    envs.set(ws.id, {
      name: str(env.name),
      data: obj(env.data),
      children: list(env.subEnvironments).map((sub) => ({ name: str(sub.name), data: obj(sub.data) })),
    });
  return { workspaces: [ws], envs };
}
