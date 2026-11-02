import path from "node:path";
import YAML, { LineCounter, isMap, isSeq, isScalar } from "yaml";
import { buildASTSchema, parse, validateSchema, GraphQLError, Source } from "graphql";
import protobuf from "protobufjs";
import { summarizeSchema } from "../graphql/schema";
import { loadProtoRoot, describeServices } from "../grpc/proto";
import { normalizeBundlePath } from "../convert/openapi-references";
import { parseSmithyIdl, SmithySyntaxError } from "./smithy";
import {
  specificationSource,
  SPEC_LIMITS,
  type SpecificationSource,
  type SpecificationAnalysis,
  type SourceLocation,
} from "./model";
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const string = (v: unknown) => (typeof v === "string" ? v : "");
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
export function analyzeSpecification(raw: SpecificationSource): SpecificationAnalysis {
  const source = specificationSource.parse(raw),
    out: SpecificationAnalysis = {
      valid: false,
      diagnostics: [],
      references: [],
      symbols: [],
      title: "",
      description: "",
      truncated: false,
    };
  const files = new Map<string, string>(),
    values = new Map<string, unknown>(),
    locations = new Map<string, Map<string, SourceLocation>>();
  const lineOffsets = new Map<string, number[]>();
  const locate = (file: string, offset = 0): SourceLocation => {
    let starts = lineOffsets.get(file);
    if (!starts) {
      starts = [0];
      const text = files.get(file) ?? "";
      for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1))
        starts.push(index + 1);
      lineOffsets.set(file, starts);
    }
    let low = 0,
      high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { file, line: low + 1, column: offset - starts[low] + 1 };
  };
  const at = (file: string, pointer = "") => locations.get(file)?.get(pointer) ?? locate(file);
  const issue = (
    message: string,
    location: SourceLocation,
    code = "syntax",
    severity: "error" | "warning" = "error",
  ) => {
    if (out.diagnostics.length < SPEC_LIMITS.diagnostics)
      out.diagnostics.push({ ...location, message: message.slice(0, 1500), code, severity });
    else out.truncated = true;
  };
  const symbol = (
    file: string,
    name: string,
    kind: string,
    detail = "",
    description = "",
    location = at(file),
  ) => {
    if (out.symbols.length < SPEC_LIMITS.symbols)
      out.symbols.push({
        ...location,
        name,
        kind,
        detail: detail.slice(0, 4000),
        description: description.slice(0, 4000),
      });
    else out.truncated = true;
  };
  let total = 0;
  for (const file of source.files) {
    if (files.has(file.path))
      issue(`Duplicate file ${file.path}`, { file: file.path, line: 1, column: 1 }, "file");
    const bytes = Buffer.byteLength(file.content);
    total += bytes;
    if (bytes > SPEC_LIMITS.bytes)
      issue("File exceeds 1 MiB", { file: file.path, line: 1, column: 1 }, "limit");
    files.set(file.path, file.content);
  }
  if (total > SPEC_LIMITS.totalBytes) issue("Bundle exceeds 3 MiB", locate(source.entrypoint), "limit");
  if (!files.has(source.entrypoint))
    issue("Entrypoint must be a supplied file", locate(source.entrypoint), "file");
  if (out.diagnostics.length) return out;
  // Bound nesting before invoking recursive third-party parsers, ignoring strings/comments.
  for (const [file, text] of files) {
    let depth = 0;
    const masked = text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\/\/[^\n]*|#[^\n]*/g, (m) =>
      " ".repeat(m.length),
    );
    for (let i = 0; i < masked.length; i++) {
      if ("{[(".includes(masked[i])) depth++;
      if ("}])".includes(masked[i])) depth--;
      if (depth > SPEC_LIMITS.depth) {
        issue("Source nesting exceeds 60 levels", locate(file, i), "limit");
        break;
      }
    }
  }
  if (out.diagnostics.length) return out;
  const parseStructured = (file: string, jsonOnly = false) => {
    const text = files.get(file)!,
      counter = new LineCounter();
    try {
      if (jsonOnly || file.endsWith(".json")) JSON.parse(text);
      const doc = YAML.parseDocument(text, { lineCounter: counter, uniqueKeys: true, version: "1.2" });
      for (const e of doc.errors) {
        const offset = e.pos?.[0] ?? 0;
        issue(e.message, locate(file, offset));
      }
      if (doc.errors.length) return;
      const value = doc.toJS({ maxAliasCount: 0 }),
        map = new Map<string, SourceLocation>();
      let nodes = 0;
      const walk = (node: unknown, pointer: string, depth: number) => {
        if (++nodes > SPEC_LIMITS.nodes || depth > SPEC_LIMITS.depth)
          throw Error("Document exceeds node/depth limit");
        const n = node as { range?: number[] };
        map.set(pointer, locate(file, n?.range?.[0] ?? 0));
        if (isMap(node))
          for (const pair of node.items)
            walk(
              pair.value,
              pointer + "/" + escape(String(isScalar(pair.key) ? pair.key.value : "")),
              depth + 1,
            );
        if (isSeq(node)) node.items.forEach((item, i) => walk(item, pointer + "/" + i, depth + 1));
      };
      walk(doc.contents, "", 0);
      locations.set(file, map);
      values.set(file, value);
    } catch (error) {
      const message = (error as Error).message;
      const position = message.match(/position (\d+)/);
      issue(message, locate(file, position ? Number(position[1]) : 0));
    }
  };
  const reference = (file: string, target: string, location: SourceLocation, resolved: boolean) => {
    if (out.references.length >= SPEC_LIMITS.symbols) {
      out.truncated = true;
      return;
    }
    out.references.push({ ...location, target, resolved });
    if (!resolved) issue(`Unresolved reference: ${target}`, location, "reference");
  };
  if (source.format === "openapi" || source.format === "asyncapi") {
    for (const file of files.keys()) parseStructured(file);
    const root = object(values.get(source.entrypoint)),
      info = object(root.info);
    out.title = string(info.title);
    out.description = string(info.description);
    if (source.format === "openapi" && !(/^3\.\d+\.\d+/.test(string(root.openapi)) || root.swagger === "2.0"))
      issue("Expected OpenAPI 3.x or Swagger 2.0", at(source.entrypoint), "format");
    if (source.format === "asyncapi" && !/^[23]\.\d+\.\d+/.test(string(root.asyncapi)))
      issue("Expected AsyncAPI 2.x or 3.x", at(source.entrypoint), "format");
    if (!out.title || !string(info.version))
      issue("info.title and info.version are required", at(source.entrypoint, "/info"), "format");
    const resolve = (file: string, target: string) => {
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("//")) return false;
      const [pathname, fragment = ""] = target.split("#");
      let targetFile: string;
      try {
        targetFile = pathname
          ? normalizeBundlePath(
              path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname))),
            )
          : file;
      } catch {
        return false;
      }
      let value = values.get(targetFile);
      if (value === undefined) return false;
      let pointer: string;
      try {
        pointer = decodeURIComponent(fragment);
      } catch {
        return false;
      }
      if (pointer && !pointer.startsWith("/")) return false;
      for (const part of pointer ? pointer.slice(1).split("/") : []) {
        if (/~(?![01])/.test(part)) return false;
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
        value = (value as Obj)[key];
      }
      return true;
    };
    for (const [file, value] of values) {
      let nodes = 0;
      const walk = (v: unknown, pointer: string, depth: number) => {
        if (++nodes > SPEC_LIMITS.nodes || depth > SPEC_LIMITS.depth) return;
        const obj = object(v);
        if (Object.hasOwn(obj, "$ref")) {
          const ref = string(obj.$ref);
          reference(file, ref, at(file, pointer + "/$ref"), !!ref && resolve(file, ref));
        }
        if (v && typeof v === "object")
          for (const [k, child] of Object.entries(v)) walk(child, pointer + "/" + escape(k), depth + 1);
      };
      walk(value, "", 0);
    }
    if (source.format === "openapi") {
      if (!root.paths && !root.webhooks && !root.components)
        issue("Expected paths, webhooks or components", at(source.entrypoint), "format");
      for (const [url, item] of Object.entries(object(root.paths)))
        for (const [method, op] of Object.entries(object(item))) {
          if (!/^(get|post|put|patch|delete|head|options|trace)$/.test(method)) continue;
          const operation = object(op),
            pointer = "/paths/" + escape(url) + "/" + method;
          symbol(
            source.entrypoint,
            method.toUpperCase() + " " + url,
            "operation",
            string(operation.operationId),
            string(operation.summary) || string(operation.description),
            at(source.entrypoint, pointer),
          );
          if (!operation.responses)
            issue("Operation requires responses", at(source.entrypoint, pointer), "format");
        }
      for (const [name, schema] of Object.entries(object(object(root.components).schemas)))
        symbol(
          source.entrypoint,
          name,
          "schema",
          string(object(schema).type),
          string(object(schema).description),
          at(source.entrypoint, "/components/schemas/" + escape(name)),
        );
      for (const [name, schema] of Object.entries(object(root.definitions)))
        symbol(
          source.entrypoint,
          name,
          "schema",
          string(object(schema).type),
          string(object(schema).description),
          at(source.entrypoint, "/definitions/" + escape(name)),
        );
    } else {
      for (const [name, channel] of Object.entries(object(root.channels))) {
        const ch = object(channel),
          pointer = "/channels/" + escape(name);
        symbol(
          source.entrypoint,
          name,
          "channel",
          string(ch.address),
          string(ch.description),
          at(source.entrypoint, pointer),
        );
        for (const mode of ["publish", "subscribe"])
          if (ch[mode])
            symbol(
              source.entrypoint,
              mode + " " + name,
              "operation",
              string(object(ch[mode]).operationId),
              string(object(ch[mode]).summary),
              at(source.entrypoint, pointer + "/" + mode),
            );
      }
      for (const [name, operation] of Object.entries(object(root.operations))) {
        const op = object(operation),
          pointer = "/operations/" + escape(name);
        symbol(
          source.entrypoint,
          name,
          "operation",
          string(op.action),
          string(op.summary),
          at(source.entrypoint, pointer),
        );
        if (!["send", "receive"].includes(string(op.action)))
          issue(
            "Operation action must be send or receive",
            at(source.entrypoint, pointer + "/action"),
            "format",
          );
        if (!op.channel) issue("Operation requires channel", at(source.entrypoint, pointer), "format");
      }
      for (const [name, msg] of Object.entries(object(object(root.components).messages)))
        symbol(
          source.entrypoint,
          name,
          "message",
          string(object(msg).contentType),
          string(object(msg).description),
          at(source.entrypoint, "/components/messages/" + escape(name)),
        );
    }
  } else if (source.format === "graphql") {
    const definitions = [];
    const offsets = new Map<string, SourceLocation>();
    for (const [file, text] of files)
      try {
        const doc = parse(new Source(text, file), { maxTokens: 50000 });
        definitions.push(...doc.definitions);
        for (const def of doc.definitions)
          if ("name" in def && def.name) offsets.set(def.name.value, locate(file, def.loc?.start ?? 0));
      } catch (error) {
        const e = error as GraphQLError;
        issue(e.message, { file, ...(e.locations?.[0] ?? { line: 1, column: 1 }) });
      }
    if (!out.diagnostics.length)
      try {
        const schema = buildASTSchema({ kind: "Document" as never, definitions });
        for (const e of validateSchema(schema))
          issue(
            e.message,
            offsets.get(
              e.nodes?.[0] && "name" in e.nodes[0]
                ? String((e.nodes[0].name as { value: string })?.value)
                : "",
            ) ?? locate(source.entrypoint),
            "schema",
          );
        for (const summary of summarizeSchema(schema).types) {
          symbol(
            source.entrypoint,
            summary.name,
            summary.kind,
            [
              ...summary.fields.map((f) => `${f.name}: ${f.type}`),
              ...(summary.values ?? []),
              ...(summary.members ?? []),
            ].join("\n"),
            summary.description,
            offsets.get(summary.name),
          );
        }
        for (const [file, text] of files) {
          const doc = parse(text);
          for (const def of doc.definitions) {
            const visit = (n: unknown) => {
              if (!n || typeof n !== "object") return;
              const node = n as Obj;
              if (node.kind === "NamedType") {
                const name = string(object(node.name).value);
                reference(
                  file,
                  name,
                  locate(file, (object(node.loc).start as number) ?? 0),
                  !!schema.getType(name),
                );
              }
              for (const [k, v] of Object.entries(node))
                if (k !== "loc")
                  if (Array.isArray(v)) v.forEach(visit);
                  else visit(v);
            };
            visit(def);
          }
        }
        out.title = schema.description ?? "GraphQL schema";
      } catch (error) {
        const e = error as GraphQLError;
        issue(
          e.message,
          { file: source.entrypoint, ...(e.locations?.[0] ?? { line: 1, column: 1 }) },
          "schema",
        );
      }
  } else if (source.format === "protobuf") {
    for (const [file, text] of files)
      try {
        const parsed = protobuf.parse(text, { keepCase: true });
        for (const target of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])])
          reference(
            file,
            target,
            locate(file, Math.max(0, text.indexOf(target))),
            files.has(target) || target.startsWith("google/protobuf/"),
          );
      } catch (error) {
        const message = (error as Error).message;
        issue(message, { file, line: Number(message.match(/line (\d+)/)?.[1] ?? 1), column: 1 });
      }
    if (!out.diagnostics.some((d) => d.code === "syntax"))
      try {
        const root = loadProtoRoot(Object.fromEntries(files));
        for (const service of describeServices(root))
          for (const method of service.methods)
            symbol(
              source.entrypoint,
              service.fullName + "/" + method.name,
              "rpc",
              `${method.clientStreaming ? "stream " : ""}${method.requestType} → ${method.serverStreaming ? "stream " : ""}${method.responseType}`,
            );
        const walk = (ns: protobuf.NamespaceBase) => {
          for (const child of ns.nestedArray) {
            if (child instanceof protobuf.Type)
              symbol(
                source.entrypoint,
                child.fullName.replace(/^\./, ""),
                "message",
                child.fieldsArray.map((f) => `${f.name}: ${f.type}`).join("\n"),
              );
            if (child instanceof protobuf.Enum)
              symbol(
                source.entrypoint,
                child.fullName.replace(/^\./, ""),
                "enum",
                Object.keys(child.values).join(", "),
              );
            if (child instanceof protobuf.Namespace) walk(child);
          }
        };
        walk(root);
        out.title = "Protobuf definitions";
      } catch (error) {
        issue((error as Error).message, locate(source.entrypoint), "schema");
      }
  } else {
    const allShapes: Record<string, Obj> = Object.create(null),
      shapeLocations = new Map<string, SourceLocation>(),
      qualifiers = new Map<string, (name: string) => string>();
    for (const [file, text] of files)
      try {
        let shapes: Obj;
        if (text.trimStart().startsWith("{")) {
          parseStructured(file, true);
          const doc = object(values.get(file));
          if (!/^2(?:\.\d+)?$/.test(string(doc.smithy)))
            issue("Expected Smithy 2 JSON AST", at(file), "format");
          shapes = object(doc.shapes);
          if (!doc.shapes) issue("Smithy JSON AST requires shapes", at(file), "format");
        } else {
          const doc = parseSmithyIdl(text);
          shapes = doc.shapes;
          qualifiers.set(file, doc.qualify);
          for (const [id, offset] of Object.entries(doc.offsets))
            shapeLocations.set(id, locate(file, offset));
        }
        for (const [id, shape] of Object.entries(shapes)) {
          if (Object.hasOwn(allShapes, id)) issue(`Duplicate shape ${id}`, at(file), "schema");
          allShapes[id] = object(shape);
          if (!shapeLocations.has(id)) shapeLocations.set(id, at(file, "/shapes/" + escape(id)));
        }
      } catch (error) {
        issue((error as Error).message, locate(file, error instanceof SmithySyntaxError ? error.offset : 0));
      }
    const kinds = new Set(
      "blob boolean string byte short integer long float double bigInteger bigDecimal timestamp document enum intEnum list map structure union service resource operation".split(
        " ",
      ),
    );
    for (const [id, shape] of Object.entries(allShapes)) {
      const location = shapeLocations.get(id)!,
        type = string(shape.type),
        members = Object.assign(
          Object.create(null),
          object(shape.members),
          ...(shape.member ? [{ member: shape.member }] : []),
          ...(shape.key ? [{ key: shape.key }] : []),
          ...(shape.value ? [{ value: shape.value }] : []),
        ) as Obj,
        qualify = qualifiers.get(location.file) ?? ((s: string) => s);
      if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*#[A-Za-z_]\w*$/.test(id))
        issue("Invalid Smithy shape ID", location, "schema");
      if (!kinds.has(type)) issue(`Unknown Smithy shape type ${type}`, location, "schema");
      const traits = object(shape.traits);
      symbol(
        location.file,
        id,
        type,
        Object.entries(members)
          .map(([n, v]) => `${n}: ${string(object(v).target) || string(object(v).value)}`)
          .join("\n"),
        string(traits["smithy.api#documentation"]) || string(traits.documentation),
        location,
      );
      const check = (target: string) => {
        const full = qualify(target);
        reference(
          location.file,
          full,
          location,
          Object.hasOwn(allShapes, full) ||
            /^smithy\.api#(?:String|Boolean|Byte|Short|Integer|Long|Float|Double|BigInteger|BigDecimal|Timestamp|Blob|Document|Unit|PrimitiveBoolean|PrimitiveByte|PrimitiveShort|PrimitiveInteger|PrimitiveLong|PrimitiveFloat|PrimitiveDouble)$/.test(
              full,
            ),
        );
      };
      for (const member of Object.values(members))
        if (object(member).target) check(string(object(member).target));
      for (const key of ["input", "output"])
        if (shape[key])
          check(typeof shape[key] === "string" ? (shape[key] as string) : string(object(shape[key]).target));
      for (const key of ["operations", "resources", "errors", "collectionOperations", "mixins"])
        if (Array.isArray(shape[key]))
          for (const item of shape[key] as unknown[])
            check(typeof item === "string" ? item : string(object(item).target));
      if (type === "service" && !string(shape.version)) issue("Service requires version", location, "schema");
      if (type === "list" && !members.member) issue("List requires member", location, "schema");
      if (type === "map" && (!members.key || !members.value))
        issue("Map requires key and value members", location, "schema");
    }
    out.title = "Smithy model";
  }
  out.valid = !out.diagnostics.some((d) => d.severity === "error");
  return out;
}
