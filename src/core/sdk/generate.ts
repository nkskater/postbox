import { SDK_RUNTIME_LICENSE } from "./license";
import { createHash } from "node:crypto";
import {
  sdkOptionsSchema,
  SDK_LIMITS,
  type SdkOptions,
  type SdkDefinition,
  type SdkArtifact,
  type SdkType,
} from "./model";
import { npmArchive, wheelArchive } from "./archive";
import { TYPESCRIPT_RUNTIME } from "./typescript-runtime";
import { PYTHON_RUNTIME } from "./python-runtime";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const pascal = (value: string) =>
  value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
export function typescriptType(type: SdkType): string {
  switch (type.kind) {
    case "json":
      return "JsonValue";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${typescriptType(type.items)}>`;
    case "union":
      return type.items.length ? type.items.map(typescriptType).join(" | ") : "JsonValue";
    case "object":
      return `{ ${Object.entries(type.properties)
        .map(
          ([key, value]) =>
            `${JSON.stringify(key)}${type.required.includes(key) ? "" : "?"}: ${typescriptType(value)};`,
        )
        .join(" ")} }`;
  }
}
function pythonType(type: SdkType): string {
  switch (type.kind) {
    case "json":
      return "JsonValue";
    case "string":
      return "str";
    case "number":
      return "int | float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array":
      return `list[${pythonType(type.items)}]`;
    case "union":
      return type.items.length ? `Union[${type.items.map(pythonType).join(", ")}]` : "JsonValue";
    case "object":
      return "dict[str, JsonValue]";
  }
}
function pythonModel(name: string, type: SdkType): string {
  if (type.kind !== "object") return `${name} = ${type.kind === "null" ? "NoneType" : pythonType(type)}\n`;
  return `${name} = TypedDict(${JSON.stringify(name)}, {${Object.entries(type.properties)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}: ${type.required.includes(key) ? "Required" : "NotRequired"}[${pythonType(value)}]`,
    )
    .join(", ")}})\n`;
}
const declarations = String.raw`
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export interface RequestContext {method:string;url:string;headers:Record<string,string>;body?:string}
export interface ClientConfig {baseUrl:string;headers?:Record<string,string>;timeoutMs?:number;auth?:(request:RequestContext)=>void|Promise<void>;onError?:(error:ApiError,request:RequestContext)=>void|Promise<void>;fetch?:typeof globalThis.fetch}
export declare class ApiError extends Error {kind:'http'|'network'|'decode'|'pagination';status?:number;body?:JsonValue;headers?:Record<string,string>;cause?:unknown}
`;
export function generateSdk(definition: SdkDefinition, raw: SdkOptions): SdkArtifact {
  const options = sdkOptionsSchema.parse(raw);
  if (!definition.operations.length || definition.operations.length > SDK_LIMITS.operations)
    throw new Error("SDK requires 1–500 operations");
  const normalized = json(definition);
  if (Buffer.byteLength(normalized) > SDK_LIMITS.sourceBytes)
    throw new Error("Normalized SDK definition exceeds 2 MiB");
  const sourceHash = createHash("sha256").update(normalized).digest("hex");
  const descriptors = Object.fromEntries(
    definition.operations.map((op) => [op.name, { method: op.method, path: op.path, bodyMode: op.bodyMode }]),
  );
  const manifest = {
    format: 1,
    package: options.name,
    version: options.version,
    language: options.language,
    sourceHash,
    operations: definition.operations.map((op) => ({
      name: op.name,
      method: op.method,
      path: op.path,
      authRequired: op.authRequired,
    })),
    warnings: definition.warnings,
  };
  const readme = `# ${options.name}\n\nSDK version ${options.version}. Source SHA-256: ${sourceHash}.\n\nConfigure an HTTP(S) base URL at runtime. No credentials, header/query/body defaults, scripts or examples are embedded. Source authentication is descriptive; the auth callback must add the required runtime headers.\n\nOperations: ${definition.operations.map((op) => op.name).join(", ")}.\n\n${definition.warnings.join("\n")}\n\nTypeScript: import {Client} from '${options.name}'; const api = new Client({baseUrl:'https://api.example.test', auth: request => {request.headers.Authorization = 'Bearer ' + process.env.API_TOKEN;}});\nPython: from ${options.name} import Client; api = Client('https://api.example.test', auth=add_runtime_auth)\n\nMethods accept path/query/body/headers (and AbortSignal in TypeScript). Query arrays use repeated keys. JSON bodies retain their types. Path parameters are encoded and must be supplied; defaults/templates are never silently resolved.\n\nApiError classifies http, network, decode and pagination failures. onError/on_error receives the error and request context; no automatic retries or logging occur. The optional fetch/transport hook controls network access. Redirects are refused by default.\n\nPagination is explicit and bounded: TypeScript api.pages(options => api.operation(options), initialOptions, (page, previous, index) => nextOptionsOrNull, 100). Python api.pages(lambda options: api.operation(**options), initial_options, next_page, max_pages=100). The callback returns the next options or null/None to finish. Never paginate side-effectful operations unless explicitly intended.\n\nRequests require Node 20+ or a modern fetch-capable browser for the npm client, and Python 3.11+ for the wheel. The npm package is ESM with generated .d.ts declarations; the Python package includes TypedDict annotations and py.typed. Structural models are compile-time hints, not runtime response validation. Nested Python object shapes use typed JSON dictionaries.\n`;
  let files: Record<string, string>, archive: Uint8Array, filename: string, contentType: string;
  if (options.language === "typescript") {
    const methodTypes: string[] = [],
      models: string[] = [],
      methods: string[] = [];
    for (const op of definition.operations) {
      const type = pascal(op.name),
        query = `{${Object.entries(op.query)
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}${value.required ? "" : "?"}:${typescriptType(value.type)};`,
          )
          .join("")}}`,
        path = `{${op.pathParameters.map((key) => `${JSON.stringify(key)}:string|number;`).join("")}}`;
      const required =
        op.pathParameters.length > 0 ||
        op.bodyMode !== "none" ||
        Object.values(op.query).some((p) => p.required);
      models.push(
        `export type ${type}Body=${typescriptType(op.bodyType)};\nexport type ${type}Response=${typescriptType(op.responseType)};\nexport interface ${type}Options {${op.pathParameters.length ? `path:${path};` : "path?:Record<string,string|number>;"}query${Object.values(op.query).some((p) => p.required) ? "" : "?"}:${query}&Record<string,string|number|boolean|null|undefined|Array<string|number|boolean>>;${op.bodyMode !== "none" ? `body:${type}Body;` : "body?:never;"}headers?:Record<string,string>;signal?:AbortSignal;}`,
      );
      methodTypes.push(`${op.name}(options${required ? "" : "?"}:${type}Options):Promise<${type}Response>;`);
      methods.push(
        `Client.prototype[${JSON.stringify(op.name)}]=function(options){return this.request(${JSON.stringify(op.name)},options);};`,
      );
    }
    const dts =
      declarations +
      "\n" +
      models.join("\n") +
      `\nexport declare class Client {constructor(config:ClientConfig);${methodTypes.join("\n")} request(operation:string,options?:unknown):Promise<JsonValue>;pages<T,O>(operation:(options:O)=>Promise<T>,initial:O,next:(page:T,previous:O,index:number)=>O|null|undefined|Promise<O|null|undefined>,maxPages?:number):AsyncGenerator<T,void,unknown>;}\n`;
    files = {
      "client.js":
        `const OPERATIONS=${json(descriptors)};\n` + TYPESCRIPT_RUNTIME + "\n" + methods.join("\n") + "\n",
      "client.d.ts": dts,
      "package.json": json({
        name: options.name,
        version: options.version,
        type: "module",
        main: "./client.js",
        types: "./client.d.ts",
        exports: { ".": { types: "./client.d.ts", import: "./client.js" } },
        files: ["client.js", "client.d.ts", "sdk-manifest.json", "README.md", "LICENSE.postbox-runtime"],
        engines: { node: ">=20" },
      }),
      "sdk-manifest.json": json(manifest),
      "README.md": readme,
      "LICENSE.postbox-runtime": SDK_RUNTIME_LICENSE,
    };
    archive = npmArchive(files);
    filename = `${options.name}-${options.version}.tgz`;
    contentType = "application/gzip";
  } else {
    const models: string[] = [],
      methods: string[] = [];
    for (const op of definition.operations) {
      const type = pascal(op.name);
      models.push(
        pythonModel(type + "Body", op.bodyType),
        pythonModel(type + "Response", op.responseType),
        `${type}Query = TypedDict(${JSON.stringify(type + "Query")}, {${Object.entries(op.query)
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}: ${value.required ? "Required" : "NotRequired"}[${pythonType(value.type)}]`,
          )
          .join(", ")}})\n`,
      );
      const args = [
        op.pathParameters.length
          ? "path: Mapping[str, str | int | float]"
          : "path: Mapping[str, str | int | float] | None = None",
        `query: ${type}Query | None = None`,
        ...(op.bodyMode !== "none" ? [`body: ${type}Body`] : []),
        "headers: Mapping[str, str] | None = None",
      ];
      methods.push(
        `    def ${op.name}(self, *, ${args.join(", ")}) -> ${type}Response:\n        return cast(${type}Response, self.request(${JSON.stringify(op.name)}, path=path, query=query, ${op.bodyMode !== "none" ? "body=body, " : ""}headers=headers))\n`,
      );
    }
    const runtime = PYTHON_RUNTIME.replace(
      "from typing import Any,",
      "from typing import Required, NotRequired, Any,",
    );
    const python =
      runtime +
      "\n" +
      methods.join("\n") +
      `\nOPERATIONS = json.loads(${JSON.stringify(JSON.stringify(descriptors))})\n` +
      models.join("\n");
    const wheel = wheelArchive(options.name, options.version, {
      [`${options.name}/__init__.py`]: python,
      [`${options.name}/py.typed`]: "",
      [`${options.name}/sdk-manifest.json`]: json(manifest),
      [`${options.name}/README.md`]: readme,
      [`${options.name}/LICENSE.postbox-runtime`]: SDK_RUNTIME_LICENSE,
    });
    files = wheel.files;
    archive = wheel.archive;
    filename = `${options.name}-${wheel.version}-py3-none-any.whl`;
    contentType = "application/zip";
  }
  if (archive.length > SDK_LIMITS.artifactBytes) throw new Error("SDK artifact exceeds 5 MiB");
  return {
    filename,
    contentType,
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
    sourceHash,
    files,
    operations: definition.operations.map((op) => op.name),
  };
}
