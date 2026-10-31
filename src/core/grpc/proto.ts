/**
 * Protobuf definitions for the gRPC client. Definitions come only from the sources
 * supplied with a request (file name -> .proto text), never from the file system, so
 * an import can never read anything the caller did not provide. Well-known types
 * (google/protobuf/*.proto) are bundled.
 */
import protobuf from "protobufjs";

export const MAX_PROTO_FILES = 50;
export const MAX_PROTO_BYTES = 1024 * 1024;

export interface GrpcMethodInfo {
  name: string;
  /** Fully qualified "package.Service/Method" path used on the wire. */
  path: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface GrpcServiceInfo {
  name: string;
  /** Fully qualified service name, e.g. "helloworld.Greeter". */
  fullName: string;
  methods: GrpcMethodInfo[];
}

export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoError";
  }
}

const wellKnown = (name: string) => {
  const entry = (
    protobuf.common as unknown as Record<
      string,
      { nested?: Record<string, protobuf.AnyNestedObject> } | undefined
    >
  )[name];
  return entry && typeof entry === "object" ? entry : undefined;
};

/** Parse every supplied file into one root and resolve all type references. */
export function loadProtoRoot(sources: Record<string, string>): protobuf.Root {
  const names = Object.keys(sources);
  if (names.length === 0) throw new ProtoError("Add at least one .proto file");
  if (names.length > MAX_PROTO_FILES)
    throw new ProtoError(`At most ${MAX_PROTO_FILES} proto files are allowed`);
  const total = names.reduce((n, k) => n + sources[k].length, 0);
  if (total > MAX_PROTO_BYTES) throw new ProtoError(`Proto sources are limited to ${MAX_PROTO_BYTES} bytes`);

  const normalized = new Set(names.map((n) => n.replace(/^\.?\//, "")));
  const root = new protobuf.Root();
  const wellKnownAdded = new Set<string>();
  for (const name of names) {
    let parsed: protobuf.IParserResult;
    try {
      parsed = protobuf.parse(sources[name], root, { keepCase: true });
    } catch (err) {
      throw new ProtoError(`${name}: ${(err as Error).message}`);
    }
    for (const imported of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
      const key = imported.replace(/^\.?\//, "");
      if (normalized.has(key)) continue;
      const known = wellKnown(imported);
      if (known?.nested) {
        if (!wellKnownAdded.has(imported)) {
          wellKnownAdded.add(imported);
          root.addJSON(known.nested);
        }
        continue;
      }
      throw new ProtoError(`${name}: import "${imported}" was not provided`);
    }
  }
  try {
    root.resolveAll();
  } catch (err) {
    throw new ProtoError((err as Error).message);
  }
  return root;
}

function collectServices(ns: protobuf.NamespaceBase, out: protobuf.Service[]) {
  for (const child of ns.nestedArray) {
    if (child instanceof protobuf.Service) out.push(child);
    else if (child instanceof protobuf.Namespace) collectServices(child, out);
  }
}

/** Services and methods in the definitions, for method pickers and validation. */
export function describeServices(root: protobuf.Root): GrpcServiceInfo[] {
  const services: protobuf.Service[] = [];
  collectServices(root, services);
  return services.map((s) => {
    const fullName = s.fullName.replace(/^\./, "");
    return {
      name: s.name,
      fullName,
      methods: s.methodsArray.map((m) => ({
        name: m.name,
        path: `/${fullName}/${m.name}`,
        requestType: (m.resolvedRequestType?.fullName ?? m.requestType).replace(/^\./, ""),
        responseType: (m.resolvedResponseType?.fullName ?? m.responseType).replace(/^\./, ""),
        clientStreaming: !!m.requestStream,
        serverStreaming: !!m.responseStream,
      })),
    };
  });
}

export interface ResolvedMethod {
  info: GrpcMethodInfo;
  request: protobuf.Type;
  response: protobuf.Type;
}

/** Find "Service/Method" ("package.Service" or the bare service name when unambiguous). */
export function resolveMethod(root: protobuf.Root, service: string, method: string): ResolvedMethod {
  const wanted = service.replace(/^\./, "");
  const matches = describeServices(root).filter((s) => s.fullName === wanted || s.name === wanted);
  const exact = matches.find((s) => s.fullName === wanted);
  const candidates = exact ? [exact] : matches;
  if (candidates.length === 0) throw new ProtoError(`Service "${service}" is not defined`);
  if (candidates.length > 1) throw new ProtoError(`Service "${service}" is ambiguous; use the full name`);
  const info = candidates[0].methods.find((m) => m.name === method);
  if (!info) throw new ProtoError(`Method "${method}" is not defined on ${candidates[0].fullName}`);
  return {
    info,
    request: root.lookupType(info.requestType),
    response: root.lookupType(info.responseType),
  };
}

const INTEGER_TYPE = /^(u?int(32|64)|s?fixed(32|64)|sint(32|64))$/;

function scalarOk(type: string, v: unknown): boolean {
  if (type === "string" || type === "bytes") return typeof v === "string";
  if (type === "bool") return typeof v === "boolean";
  if (type === "double" || type === "float")
    return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));
  if (INTEGER_TYPE.test(type))
    return (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v));
  return true;
}

/**
 * protobufjs silently drops unknown fields and coerces wrong types, which would send an
 * empty or wrong message without telling the user. Check the JSON against the schema first.
 */
function checkMessage(type: protobuf.Type, value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProtoError(`${path || type.name} must be a JSON object`);
  for (const [key, raw] of Object.entries(value)) {
    const at = `${path}${key}`;
    const field = type.fields[key];
    if (!field) {
      const known = Object.keys(type.fields).join(", ");
      throw new ProtoError(`Unknown field "${at}" in ${type.name}${known ? ` (fields: ${known})` : ""}`);
    }
    if (raw === null) continue;
    field.resolve();
    let items: unknown[];
    if (field.map) {
      if (typeof raw !== "object" || Array.isArray(raw))
        throw new ProtoError(`"${at}" must be a JSON object`);
      items = Object.values(raw);
    } else if (field.repeated) {
      if (!Array.isArray(raw)) throw new ProtoError(`"${at}" must be an array`);
      items = raw;
    } else items = [raw];
    for (const item of items) {
      const resolved = field.resolvedType;
      if (resolved instanceof protobuf.Type) checkMessage(resolved, item, `${at}.`);
      else if (resolved instanceof protobuf.Enum) {
        const ok = typeof item === "string" ? item in resolved.values : Number.isInteger(item);
        if (!ok) throw new ProtoError(`"${at}" is not a value of enum ${resolved.name}`);
      } else if (!scalarOk(field.type, item)) throw new ProtoError(`"${at}" must be a ${field.type}`);
    }
  }
}

/** JSON (int64 as string, bytes as base64) -> message bytes; rejects unknown shapes. */
export function encodeMessage(type: protobuf.Type, value: unknown): Buffer {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProtoError(`${type.name} messages must be JSON objects`);
  checkMessage(type, value, "");
  let message: protobuf.Message;
  try {
    message = type.fromObject(value as Record<string, unknown>);
  } catch (err) {
    throw new ProtoError(`Invalid ${type.name}: ${(err as Error).message}`);
  }
  const problem = type.verify(message);
  if (problem) throw new ProtoError(`Invalid ${type.name}: ${problem}`);
  return Buffer.from(type.encode(message).finish());
}

/** Message bytes -> JSON-safe object with int64 as strings and bytes as base64. */
export function decodeMessage(type: protobuf.Type, buf: Buffer): unknown {
  return type.toObject(type.decode(buf), {
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    oneofs: true,
  });
}
