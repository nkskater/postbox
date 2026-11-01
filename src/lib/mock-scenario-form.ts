/** Turning the scenario form into a validated scenario, and describing scenarios in plain words. */
import { scenarioSchema, type Scenario } from "@/core/mocks/scenarios";

export type ScenarioKind = Scenario["kind"];

export const KINDS: { kind: ScenarioKind; label: string; hint: string }[] = [
  {
    kind: "failFirst",
    label: "Fail the first N requests",
    hint: "Then serve normally, like a service that is still starting.",
  },
  {
    kind: "failEvery",
    label: "Fail every Nth request",
    hint: "Every Nth request in a session gets the error.",
  },
  { kind: "error", label: "Always fail", hint: "Every matching request gets the error." },
  {
    kind: "sequence",
    label: "Status sequence",
    hint: "One status per request, in order. 0 serves the saved example.",
  },
  {
    kind: "rateLimit",
    label: "Rate limit",
    hint: "Allow N requests per window, then answer 429 with Retry-After.",
  },
  { kind: "delay", label: "Add latency", hint: "Wait before responding (adds to the mock's own delay)." },
];

export interface ScenarioForm {
  kind: ScenarioKind;
  name: string;
  method: string;
  path: string;
  ms: string;
  status: string;
  count: string;
  every: string;
  statuses: string;
  repeat: boolean;
  limit: string;
  windowSeconds: string;
  body: string;
}

export const emptyForm = (): ScenarioForm => ({
  kind: "failFirst",
  name: "",
  method: "",
  path: "",
  ms: "500",
  status: "503",
  count: "2",
  every: "3",
  statuses: "500, 0, 429",
  repeat: true,
  limit: "5",
  windowSeconds: "60",
  body: "",
});

/** Switch the simulation type, moving the status to that type's natural default unless the user changed it. */
export function withKind(form: ScenarioForm, kind: ScenarioKind): ScenarioForm {
  const natural = (k: ScenarioKind) => (k === "rateLimit" ? "429" : "503");
  const untouched = form.status === natural(form.kind);
  return { ...form, kind, status: untouched ? natural(kind) : form.status };
}

const num = (value: string) => (value.trim() === "" ? NaN : Number(value));

/** Validate the form; throws an Error with a readable message. */
export function buildScenario(form: ScenarioForm, id: string): Scenario {
  const match = {
    ...(form.method.trim() ? { method: form.method.trim() } : {}),
    ...(form.path.trim() ? { path: form.path.trim() } : {}),
  };
  const common = {
    id,
    name: form.name.trim() || KINDS.find((k) => k.kind === form.kind)!.label,
    enabled: true,
    match,
  };
  const failure = { status: num(form.status), ...(form.body ? { body: form.body } : {}) };
  let candidate: unknown;
  switch (form.kind) {
    case "delay":
      candidate = { ...common, kind: "delay", ms: num(form.ms) };
      break;
    case "error":
      candidate = { ...common, kind: "error", ...failure };
      break;
    case "failFirst":
      candidate = { ...common, kind: "failFirst", count: num(form.count), ...failure };
      break;
    case "failEvery":
      candidate = { ...common, kind: "failEvery", every: num(form.every), ...failure };
      break;
    case "sequence":
      candidate = {
        ...common,
        kind: "sequence",
        statuses: form.statuses
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number),
        repeat: form.repeat,
        ...(form.body ? { body: form.body } : {}),
      };
      break;
    case "rateLimit":
      candidate = {
        ...common,
        kind: "rateLimit",
        limit: num(form.limit),
        windowSeconds: num(form.windowSeconds),
        ...(form.status.trim() ? { status: num(form.status) } : {}),
        ...(form.body ? { body: form.body } : {}),
      };
      break;
  }
  const parsed = scenarioSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.filter((p) => p !== "match").join(".");
    throw new Error(field ? `${field}: ${issue.message}` : issue.message);
  }
  return parsed.data;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeScenario(s: Scenario): string {
  const where = [s.match.method?.toUpperCase(), s.match.path].filter(Boolean).join(" ");
  const scope = where ? ` on ${where}` : "";
  switch (s.kind) {
    case "delay":
      return `Adds ${s.ms} ms of latency${scope}`;
    case "error":
      return `Always answers ${s.status}${scope}`;
    case "failFirst":
      return `Answers ${s.status} to the first ${plural(s.count, "request")}${scope}`;
    case "failEvery":
      return `Answers ${s.status} to every ${s.every}th request${scope}`;
    case "sequence":
      return `Answers ${s.statuses.map((c) => (c === 0 ? "example" : c)).join(", ")}${s.repeat ? ", then repeats" : ", then keeps the last"}${scope}`;
    case "rateLimit":
      return `Allows ${plural(s.limit, "request")} per ${s.windowSeconds} s, then ${s.status}${scope}`;
  }
}
