import { FORBIDDEN_KEYS, MAX_VALUE_BYTES, jsonBudget, type Expression, type Json } from "./model";
export interface ExpressionContext {
  input: Json;
  value: Json;
  steps: Record<string, Json>;
  item?: Json;
  index?: number;
}
export interface ExpressionBudget {
  remaining: number;
  check?: () => void;
}
const numeric = (v: Json): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Expected a finite number");
  return v;
};
const array = (v: Json): Json[] => {
  if (!Array.isArray(v)) throw new Error("Expected an array");
  return v;
};
const text = (v: Json): string => (typeof v === "string" ? v : JSON.stringify(v));
function own(value: unknown, key: string): Json {
  if (FORBIDDEN_KEYS.has(key)) throw new Error("Prototype paths are not allowed");
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
  return (value as Record<string, Json>)[key] ?? null;
}
function equal(a: Json, b: Json, budget: ExpressionBudget): boolean {
  budget.check?.();
  if (--budget.remaining < 0) throw new Error("Expression evaluation limit exceeded");
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b))
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equal((a as Record<string, Json>)[key], (b as Record<string, Json>)[key], budget),
    )
  );
}
export function evaluate(
  expression: Expression,
  context: ExpressionContext,
  budget: ExpressionBudget = { remaining: 10000 },
  depth = 0,
): Json {
  budget.check?.();
  if (--budget.remaining < 0 || depth > 20) throw new Error("Expression evaluation limit exceeded");
  const evalChild = (child: Expression) => evaluate(child, context, budget, depth + 1);
  let result: Json;
  switch (expression.kind) {
    case "literal":
      result = expression.value;
      break;
    case "path": {
      const parts = expression.path.split(".");
      if (!["input", "value", "steps", "item", "index"].includes(parts[0]))
        throw new Error("Paths start with input, value, steps, item or index");
      let current: unknown = context;
      for (const part of parts) {
        if (!part) throw new Error("Empty path segment");
        current = own(current, part);
      }
      result = current as Json;
      break;
    }
    case "array":
      result = expression.items.map(evalChild);
      break;
    case "object":
      result = Object.fromEntries(
        Object.entries(expression.fields).map(([key, expr]) => [key, evalChild(expr)]),
      );
      break;
    case "op": {
      // Lazy boolean/coalesce operands allow guards around absent data and invalid branches.
      const values = () => expression.args.map(evalChild);
      const count = (n: number) => {
        if (expression.args.length !== n) throw new Error(`${expression.op} expects ${n} operands`);
      };
      const unary = () => {
        count(1);
        return evalChild(expression.args[0]);
      };
      const pair = () => {
        count(2);
        return values() as [Json, Json];
      };
      switch (expression.op) {
        case "and":
          result = true;
          for (const expr of expression.args) {
            const v = evalChild(expr);
            if (typeof v !== "boolean") throw new Error("and expects booleans");
            if (!v) {
              result = false;
              break;
            }
          }
          break;
        case "or":
          result = false;
          for (const expr of expression.args) {
            const v = evalChild(expr);
            if (typeof v !== "boolean") throw new Error("or expects booleans");
            if (v) {
              result = true;
              break;
            }
          }
          break;
        case "coalesce":
          result = null;
          for (const expr of expression.args) {
            const v = evalChild(expr);
            if (v !== null) {
              result = v;
              break;
            }
          }
          break;
        case "not": {
          const v = unary();
          if (typeof v !== "boolean") throw new Error("not expects a boolean");
          result = !v;
          break;
        }
        case "eq": {
          const [a, b] = pair();
          result = equal(a, b, budget);
          break;
        }
        case "ne": {
          const [a, b] = pair();
          result = !equal(a, b, budget);
          break;
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          const [a, b] = pair();
          const x = numeric(a),
            y = numeric(b);
          result =
            expression.op === "lt"
              ? x < y
              : expression.op === "lte"
                ? x <= y
                : expression.op === "gt"
                  ? x > y
                  : x >= y;
          break;
        }
        case "add":
          result = values().reduce<number>((sum, v) => sum + numeric(v), 0);
          break;
        case "multiply":
          result = values().reduce<number>((product, v) => product * numeric(v), 1);
          break;
        case "subtract": {
          const [a, b] = pair();
          result = numeric(a) - numeric(b);
          break;
        }
        case "divide":
        case "mod": {
          const [a, b] = pair(),
            divisor = numeric(b);
          if (!divisor) throw new Error("Division by zero");
          result = expression.op === "divide" ? numeric(a) / divisor : numeric(a) % divisor;
          break;
        }
        case "concat": {
          const parts = values().map(text);
          if (parts.reduce((n, v) => n + v.length, 0) > MAX_VALUE_BYTES)
            throw new Error("Concatenated text exceeds the data limit");
          result = parts.join("");
          break;
        }
        case "length": {
          const v = unary();
          if (typeof v !== "string" && !Array.isArray(v)) throw new Error("length expects text or an array");
          result = v.length;
          break;
        }
        case "contains": {
          const [a, b] = pair();
          result = typeof a === "string" ? a.includes(text(b)) : array(a).some((v) => equal(v, b, budget));
          break;
        }
        case "get": {
          if (expression.args.length < 2 || expression.args.length > 3)
            throw new Error("get expects 2 or 3 operands");
          const a = evalChild(expression.args[0]),
            b = evalChild(expression.args[1]);
          if (typeof b !== "string" && typeof b !== "number")
            throw new Error("get expects a property name or index");
          const key = String(b);
          result = own(a, key);
          if (expression.args.length === 3 && (!a || typeof a !== "object" || !Object.hasOwn(a, key)))
            result = evalChild(expression.args[2]);
          break;
        }
        case "range": {
          if (expression.args.length < 1 || expression.args.length > 3)
            throw new Error("range expects 1 to 3 operands");
          const args = values().map(numeric);
          const start = args.length === 1 ? 0 : args[0],
            end = args.length === 1 ? args[0] : args[1],
            step = args[2] ?? 1;
          if (args.some((value) => !Number.isSafeInteger(value)) || step === 0)
            throw new Error("range expects safe integers and a nonzero step");
          const length = Math.max(0, Math.ceil((end - start) / step));
          if (length > 1000 || !Number.isSafeInteger(length))
            throw new Error("range permits at most 1000 items");
          result = Array.from({ length }, (_, i) => start + i * step);
          break;
        }
        case "join": {
          const [a, b] = pair();
          const parts = array(a).map(text),
            separator = text(b);
          if (
            parts.reduce((n, v) => n + v.length, 0) + Math.max(0, parts.length - 1) * separator.length >
            MAX_VALUE_BYTES
          )
            throw new Error("Joined text exceeds the data limit");
          result = parts.join(separator);
          break;
        }
        case "json":
          result = JSON.stringify(unary());
          break;
        case "parseJson": {
          const value = unary();
          if (typeof value !== "string" || value.length > MAX_VALUE_BYTES)
            throw new Error("parseJson expects bounded JSON text");
          result = JSON.parse(value);
          break;
        }
        case "sum":
          result = array(unary()).reduce<number>((sum, v) => sum + numeric(v), 0);
          break;
        case "compact":
          result = array(unary()).filter((v) => v !== null);
          break;
        case "merge": {
          const entries: [string, Json][] = [];
          for (const v of values()) {
            if (v === null || Array.isArray(v) || typeof v !== "object")
              throw new Error("merge expects records");
            entries.push(...Object.entries(v));
            if (entries.length > 1000) throw new Error("Merged record exceeds the field limit");
          }
          result = Object.fromEntries(entries);
          break;
        }
      }
      break;
    }
  }
  jsonBudget(result);
  return result;
}
