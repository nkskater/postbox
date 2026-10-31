/** Native Thunder Client export migration; source scripts are never executed. */
import { z } from "zod";
import type { FolderNode, KeyValue, RequestNode, Variable } from "../types";
import { importAuth, importPostmanCollection, type PostmanCollection } from "./postman";

type Data = Record<string, unknown>;
const data = (v: unknown): Data => z.record(z.string(), z.unknown()).parse(v);
const array = (v: unknown): Data[] =>
  v === undefined ? [] : z.array(z.record(z.string(), z.unknown())).parse(v);
const text = (v: unknown): string =>
  Array.isArray(v)
    ? v.map((x) => z.string().parse(x)).join("\n")
    : v === undefined || v === null
      ? ""
      : z.string().parse(v);
const enabled = (v: Data) => v.isDisabled !== true && v.disabled !== true && v.active !== false;
type PMItem = PostmanCollection["item"][number];
type PMRequest = Exclude<NonNullable<PMItem["request"]>, string>;
type PMAuth = NonNullable<PMRequest["auth"]>;
export function isThunderClient(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Data;
  const client = v.clientName ?? v.client;
  return typeof client === "string" && /^thunder\s*client$/i.test(client);
}
export function importThunderClient(
  value: unknown,
  options: { includeCredentials?: boolean } = {},
):
  | { kind: "collection"; root: FolderNode; variables: Variable[]; warnings: string[] }
  | { kind: "environment"; name: string; variables: Variable[]; warnings: string[] } {
  if (!options.includeCredentials)
    throw new Error(
      "Thunder Client exports may contain credentials. Explicitly enable includeCredentials to import them.",
    );
  const source = data(value);
  if (!isThunderClient(source) || !["1.0", "1.1", "1.2", "1.3", "1.4"].includes(text(source.version)))
    throw new Error("Unsupported Thunder Client export version (expected 1.0–1.4).");
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < 200) warnings.push(message);
  };
  const variables = (v: unknown): Variable[] =>
    array(v).map((item) => ({
      key: z.string().parse(item.name ?? item.key),
      value: text(item.value),
      enabled: enabled(item),
      type: item.isSecret === true || item.secret === true || item.type === "secret" ? "secret" : "default",
    }));
  if (source.environmentName !== undefined)
    return {
      kind: "environment",
      name: z.string().parse(source.environmentName),
      variables: variables(source.variables),
      warnings,
    };
  const collectionName = z.string().parse(source.collectionName);
  const folders = array(source.folders),
    requests = array(source.requests);
  if (folders.length + requests.length > 10000) throw new Error("Thunder Client export exceeds 10000 items.");
  const byId = new Map<string, Data>();
  for (const folder of folders) {
    const id = z.string().min(1).parse(folder._id);
    if (byId.has(id)) throw new Error("Duplicate Thunder Client folder identifier.");
    byId.set(id, folder);
  }
  const parent = (item: Data): string => {
    const a = text(item.containerId),
      b = text(item.parentId);
    if (a && b && a !== b) throw new Error("Conflicting Thunder Client parent links.");
    const id = a || b;
    if (id && id === source.collectionId) return "";
    if (id && !byId.has(id)) throw new Error("Thunder Client item references a missing folder.");
    return id;
  };
  const grouped = new Map<string, Data[]>();
  for (const item of [...folders, ...requests]) {
    const key = parent(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  const order = (items: Data[]) =>
    items
      .map((value, index) => ({ value, index }))
      .sort(
        (a, b) =>
          (typeof a.value.sortNum === "number" ? a.value.sortNum : a.index) -
            (typeof b.value.sortNum === "number" ? b.value.sortNum : b.index) || a.index - b.index,
      )
      .map((v) => v.value);
  for (const folder of folders) {
    let current = text(folder._id);
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current) || seen.size > 50)
        throw new Error("Thunder Client folder cycle or excessive nesting.");
      seen.add(current);
      current = parent(byId.get(current)!);
    }
  }
  for (const r of requests) parent(r);
  const row = (v: Data) => ({ key: text(v.name ?? v.key), value: text(v.value), enabled: enabled(v) });
  const headers = (inherited: KeyValue[], values: unknown) => {
    const merged = new Map(inherited.map((h) => [h.key.toLowerCase(), h]));
    for (const raw of array(values)) {
      const h = row(raw);
      if (h.enabled || !merged.has(h.key.toLowerCase())) merged.set(h.key.toLowerCase(), h);
    }
    return [...merged.values()];
  };
  const settings = (v: Data) => (v.settings === undefined ? {} : data(v.settings));
  const baseUrl = (s: Data, inherited: string) => {
    const opts = s.options === undefined ? {} : data(s.options);
    if (Object.keys(opts).some((key) => key !== "baseUrl"))
      warn("Source transport settings were not migrated; review request settings.");
    return text(opts.baseUrl) || inherited;
  };
  const auth = (value: unknown): PMAuth | undefined => {
    if (value === undefined) return undefined;
    const a = data(value),
      type = text(a.type);
    if (type === "inherit" || !type) return undefined;
    if (type === "none") return { type: "noauth" };
    if (type === "bearer") {
      const token = typeof a.bearer === "string" ? a.bearer : data(a.bearer ?? {}).token;
      return { type, bearer: [{ key: "token", value: text(token) }] };
    }
    if (type === "basic" || type === "digest") {
      const b = data(a[type] ?? {});
      return {
        type,
        [type]: [
          { key: "username", value: text(b.username) },
          { key: "password", value: text(b.password) },
        ],
      };
    }
    if (type === "apikey" || type === "api-key") {
      const key = data(a.apikey ?? a.apiKey ?? {});
      return {
        type: "apikey",
        apikey: [
          { key: "key", value: text(key.key ?? key.name) },
          { key: "value", value: text(key.value) },
          { key: "in", value: /query/i.test(text(key.in ?? key.addTo)) ? "query" : "header" },
        ],
      };
    }
    if (type === "oauth2" && a.oauth2 && typeof a.oauth2 === "object") {
      const oauth = data(a.oauth2);
      const token = text(oauth.accessToken ?? oauth.token);
      if (token) {
        warn("OAuth token imported as bearer; configure token refresh separately.");
        return { type: "bearer", bearer: [{ key: "token", value: token }] };
      }
    }
    warn("Unsupported source authentication was disabled; configure it before sending.");
    return { type: "noauth" };
  };
  const scripts = (v: Data) => {
    const nonempty = (value: unknown) =>
      Array.isArray(value)
        ? value.length > 0
        : value && typeof value === "object"
          ? Object.keys(value).length > 0
          : typeof value === "string" && value.trim().length > 0;
    if ([v.tests, v.scripts, v.preRequestScript, v.testScript].some(nonempty))
      warn(`${text(v.name) || collectionName}: tests/scripts were not translated and remain disabled.`);
  };
  const docs = (v: Data) => text(v.docs ?? v.description);
  const rootSettings = settings(source);
  scripts(source);
  scripts(rootSettings);
  const root: FolderNode = {
    kind: "folder",
    id: "thunder-root",
    name: collectionName,
    description: docs(source),
    auth: importAuth(auth(rootSettings.auth ?? source.auth)),
    headers: [],
    preRequestScript: "",
    testScript: "",
    children: [],
  };
  const fill = (node: FolderNode, id: string, inheritedHeaders: KeyValue[], inheritedBase: string): void => {
    const children = order(grouped.get(id) ?? []);
    for (const child of children) {
      const s = settings(child);
      scripts(child);
      scripts(s);
      const base = baseUrl(s, inheritedBase);
      const effectiveHeaders = headers(inheritedHeaders, s.headers);
      if (byId.get(text(child._id)) === child) {
        if (child.variables || s.variables)
          throw new Error("Folder-local variables require an environment export before migration.");
        const folder: FolderNode = {
          kind: "folder",
          id: text(child._id),
          name: z.string().parse(child.name),
          description: docs(child),
          auth: importAuth(auth(s.auth ?? child.auth)),
          headers: [],
          preRequestScript: "",
          testScript: "",
          children: [],
        };
        node.children.push(folder);
        fill(folder, text(child._id), headers(effectiveHeaders, child.headers), base);
        continue;
      }
      let url = z.string().parse(child.url);
      if (!/^https?:\/\//i.test(url) && !url.startsWith("{{") && base)
        url = base.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
      const params = array(child.params);
      const encode = (s: string) =>
        s
          .split(/(\{\{[^{}]+\}\})/)
          .map((p) => (p.startsWith("{{") ? p : encodeURIComponent(p)))
          .join("");
      for (const param of params.filter((p) => p.isPath)) {
        if (!enabled(param)) {
          warn("Disabled path parameter was left unresolved; configure it before sending.");
          continue;
        }
        url = url
          .split(/(\{\{[^{}]+\}\})/)
          .map((part) =>
            part.startsWith("{{")
              ? part
              : part.split(`{${text(param.name)}}`).join(encode(text(param.value))),
          )
          .join("");
      }
      const hashIndex = url.indexOf("#"),
        fragment = hashIndex < 0 ? "" : url.slice(hashIndex);
      if (hashIndex >= 0) url = url.slice(0, hashIndex);
      const queryIndex = url.indexOf("?"),
        endpoint = queryIndex < 0 ? url : url.slice(0, queryIndex);
      const originalQuery = [...new URLSearchParams(queryIndex < 0 ? "" : url.slice(queryIndex + 1))];
      const matched = new Set<number>();
      for (const param of params.filter((p) => !p.isPath)) {
        const name = text(param.name),
          value = text(param.value);
        const found = originalQuery.findIndex(([k, v], i) => !matched.has(i) && k === name && v === value);
        if (found >= 0) {
          matched.add(found);
          if (!enabled(param)) originalQuery[found] = ["", ""];
        } else if (enabled(param)) {
          originalQuery.push([name, value]);
          matched.add(originalQuery.length - 1);
        }
      }
      const query = originalQuery.filter(([k, v]) => k || v);
      url =
        endpoint +
        (query.length ? "?" + query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&") : "") +
        fragment;
      const b = child.body === undefined ? {} : data(child.body);
      let body: PMRequest["body"];
      const type = text(b.type);
      if (array(b.files).length || array(b.form).some((p) => p.isFile === true || p.type === "file"))
        throw new Error("Thunder Client file bytes are not exported; remove file uploads before importing.");
      if (type === "json" || type === "xml" || type === "text" || type === "html")
        body = { mode: "raw", raw: text(b.raw), options: { raw: { language: type } } };
      else if (type === "formencoded" || type === "formdata")
        body = {
          mode: type === "formencoded" ? "urlencoded" : "formdata",
          [type === "formencoded" ? "urlencoded" : "formdata"]: array(b.form).map((p) => ({
            key: text(p.name),
            value: text(p.value),
            disabled: !enabled(p),
            type: "text",
          })),
        };
      else if (type === "graphql") {
        const g = data(b.graphql ?? {});
        body = { mode: "graphql", graphql: { query: text(g.query), variables: text(g.variables) || "{}" } };
      } else if (type === "binary") {
        warn("Binary file was not exported; select its file before sending.");
        body = { mode: "file" };
      } else if (type && type !== "none") throw new Error("Unsupported Thunder Client request body mode.");
      const requestHeaders = headers(effectiveHeaders, child.headers);
      const item = importPostmanCollection({
        info: { name: collectionName },
        item: [
          {
            name: z.string().parse(child.name),
            request: {
              method: z
                .string()
                .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
                .parse(child.method),
              url,
              header: requestHeaders.map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })),
              auth: auth(child.auth ?? s.auth),
              body,
              description: docs(child),
            },
          },
        ],
      }).root.children[0] as RequestNode;
      item.params = [
        ...query.map(([key, value]) => ({ key, value, enabled: true })),
        ...params.filter((p) => !p.isPath && !enabled(p)).map(row),
      ];
      item.settings.useCookieJar = false;
      node.children.push(item);
    }
  };
  fill(root, "", headers(headers([], rootSettings.headers), source.headers), baseUrl(rootSettings, ""));
  return {
    kind: "collection",
    root,
    variables: variables(source.variables ?? rootSettings.variables),
    warnings,
  };
}
