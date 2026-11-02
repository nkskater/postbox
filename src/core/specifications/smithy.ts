/** Bounded Smithy IDL reader. Produces the same shape map used by the JSON AST inspector. */
export interface SmithyToken {
  value: string;
  offset: number;
  quoted?: boolean;
}
export class SmithySyntaxError extends Error {
  constructor(
    message: string,
    public offset: number,
  ) {
    super(message);
  }
}
export function parseSmithyIdl(source: string) {
  const tokens: SmithyToken[] = [];
  const pattern =
    /\s+|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w.$#]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]():,@=]/gy;
  let at = 0;
  while (at < source.length) {
    pattern.lastIndex = at;
    const m = pattern.exec(source);
    if (!m) throw new SmithySyntaxError("Unexpected Smithy token", at);
    at = pattern.lastIndex;
    if (/^\s|^\/\//.test(m[0])) continue;
    const raw = m[0],
      quoted = raw.startsWith('"');
    let value = raw;
    if (quoted) {
      try {
        value = raw.startsWith('"""') ? raw.slice(3, -3) : JSON.parse(raw);
      } catch {
        throw new SmithySyntaxError("Invalid string", m.index);
      }
    }
    tokens.push({ value, offset: m.index, quoted });
    if (tokens.length > 50000) throw new SmithySyntaxError("Smithy token limit exceeded", m.index);
  }
  let i = 0;
  const fail = (message: string): never => {
    throw new SmithySyntaxError(message, tokens[i]?.offset ?? source.length);
  };
  const take = () => tokens[i++] ?? fail("Unexpected end of document");
  const accept = (s: string) => (tokens[i]?.value === s && !tokens[i]?.quoted ? (++i, true) : false);
  const expect = (s: string) => {
    if (!accept(s)) fail(`Expected ${s}`);
  };
  const identifier = () => {
    const t = take();
    if (t.quoted || !/^[A-Za-z_$][\w.$#]*$/.test(t.value)) fail("Expected identifier");
    return t.value;
  };
  type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
  const node = (depth = 0): Value => {
    if (depth > 60) fail("Smithy nesting limit exceeded");
    if (accept("{")) {
      const out: Record<string, Value> = Object.create(null);
      while (!accept("}")) {
        const key = take().value;
        expect(":");
        if (Object.hasOwn(out, key)) fail(`Duplicate property ${key}`);
        out[key] = node(depth + 1);
        accept(",");
      }
      return out;
    }
    if (accept("[")) {
      const out: Value[] = [];
      while (!accept("]")) {
        out.push(node(depth + 1));
        accept(",");
      }
      return out;
    }
    const t = take();
    if (t.quoted) return t.value;
    if (t.value === "true" || t.value === "false") return t.value === "true";
    if (t.value === "null") return null;
    if (/^-?\d/.test(t.value)) return Number(t.value);
    if (!/^[\w.$#]+$/.test(t.value)) fail("Expected node value");
    return t.value;
  };
  const traits = (): Record<string, Value> => {
    const out: Record<string, Value> = Object.create(null);
    while (accept("@")) {
      const name = identifier();
      let value: Value = {};
      if (accept("(")) {
        if (tokens[i + 1]?.value === ":") {
          const props: Record<string, Value> = Object.create(null);
          while (!accept(")")) {
            const key = take().value;
            expect(":");
            props[key] = node();
            accept(",");
          }
          value = props;
        } else {
          value = node();
          expect(")");
        }
      }
      out[name] = value;
    }
    return out;
  };
  let version = "",
    namespace = "";
  const uses: Record<string, string> = Object.create(null),
    shapes: Record<string, Record<string, unknown>> = Object.create(null),
    offsets: Record<string, number> = Object.create(null);
  const kinds = new Set(
    "blob boolean string byte short integer long float double bigInteger bigDecimal timestamp document enum intEnum list map structure union service resource operation".split(
      " ",
    ),
  );
  while (i < tokens.length) {
    if (accept("$version")) {
      expect(":");
      version = String(node());
      continue;
    }
    if (accept("$operationInputSuffix") || accept("$operationOutputSuffix")) {
      expect(":");
      node();
      continue;
    }
    if (accept("metadata")) {
      identifier();
      expect("=");
      node();
      continue;
    }
    if (accept("namespace")) {
      if (namespace) fail("Duplicate namespace");
      namespace = identifier();
      continue;
    }
    if (accept("use")) {
      const target = identifier();
      uses[target.split("#").at(-1)!] = target;
      continue;
    }
    const applied = traits();
    if (accept("apply")) {
      identifier();
      traits();
      continue;
    }
    const kind = identifier();
    if (!kinds.has(kind)) fail(`Unknown shape type ${kind}`);
    if (!namespace) fail("Declare a namespace before shapes");
    const token = tokens[i],
      name = identifier(),
      id = namespace + "#" + name;
    if (Object.hasOwn(shapes, id)) fail(`Duplicate shape ${name}`);
    const shape: Record<string, unknown> = { type: kind, traits: applied };
    shapes[id] = shape;
    offsets[id] = token.offset;
    if (accept("for")) shape.resource = identifier();
    if (accept("with")) shape.mixins = node();
    if (!accept("{")) {
      if (
        ["list", "map", "structure", "union", "service", "resource", "operation", "enum", "intEnum"].includes(
          kind,
        )
      )
        fail("Expected shape body");
      continue;
    }
    const members: Record<string, unknown> = Object.create(null);
    while (!accept("}")) {
      const memberTraits = traits(),
        member = identifier();
      if (accept(":")) {
        if (["structure", "union", "list", "map"].includes(kind)) {
          const target = identifier();
          members[member] = { target, traits: memberTraits };
          if (accept("=")) (members[member] as Record<string, unknown>).default = node();
        } else if (kind === "operation" && accept("=")) {
          const inlineId = id + (member === "input" ? "Input" : "Output");
          const inlineTraits = traits();
          expect("{");
          const inline: Record<string, unknown> = Object.create(null);
          while (!accept("}")) {
            const applied = traits(),
              field = identifier();
            expect(":");
            const target = identifier();
            inline[field] = { target, traits: applied };
            if (accept("=")) (inline[field] as Record<string, unknown>).default = node();
            accept(",");
          }
          shapes[inlineId] = { type: "structure", members: inline, traits: inlineTraits };
          offsets[inlineId] = token.offset;
          shape[member] = { target: inlineId };
        } else shape[member] = node();
      } else if (kind === "enum" || kind === "intEnum") {
        members[member] = { traits: memberTraits, ...(accept("=") ? { value: node() } : {}) };
      } else if (member.startsWith("$")) members[member] = { target: member.slice(1), traits: memberTraits };
      else fail("Expected member target or property");
      accept(",");
    }
    if (Object.keys(members).length) shape.members = members;
  }
  if (!/^2(?:\.\d+)?$/.test(version)) fail('Smithy IDL requires $version: "2"');
  const qualify = (name: string) =>
    name.includes("#")
      ? name
      : (uses[name] ??
        (/^(String|Boolean|Byte|Short|Integer|Long|Float|Double|BigInteger|BigDecimal|Timestamp|Blob|Document|Unit|PrimitiveBoolean|PrimitiveByte|PrimitiveShort|PrimitiveInteger|PrimitiveLong|PrimitiveFloat|PrimitiveDouble)$/.test(
          name,
        )
          ? "smithy.api#" + name
          : namespace + "#" + name));
  return { smithy: "2.0", shapes, offsets, qualify };
}
