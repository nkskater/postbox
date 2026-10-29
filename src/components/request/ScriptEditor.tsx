"use client";
/**
 * JavaScript editor for pre-request / post-response scripts with a snippet list.
 */
import { CodeEditor } from "@/components/editor/CodeEditor";

const PRE_SNIPPETS: { label: string; code: string }[] = [
  { label: "Set an environment variable", code: 'pm.environment.set("variable_key", "variable_value");' },
  {
    label: "Set a collection variable",
    code: 'pm.collectionVariables.set("variable_key", "variable_value");',
  },
  { label: "Get a variable", code: 'const value = pm.variables.get("variable_key");' },
  {
    label: "Add a header",
    code: 'pm.request.headers.add({ key: "X-Request-Id", value: pm.variables.replaceIn("{{$guid}}") });',
  },
  { label: "Timestamp variable", code: 'pm.variables.set("now", new Date().toISOString());' },
  {
    label: "Send a request",
    code: 'const res = await pm.sendRequest("https://postman-echo.com/get");\nconsole.log(res.json());',
  },
  { label: "Skip this request", code: 'if (!pm.environment.get("enabled")) pm.execution.skipRequest();' },
];

const TEST_SNIPPETS: { label: string; code: string }[] = [
  {
    label: "Status code is 200",
    code: 'pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});',
  },
  {
    label: "Response time below 500ms",
    code: 'pm.test("Response time is below 500ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});',
  },
  {
    label: "Body contains string",
    code: 'pm.test("Body contains string", () => {\n  pm.expect(pm.response.text()).to.include("string_you_want_to_search");\n});',
  },
  {
    label: "JSON value check",
    code: 'pm.test("JSON value check", () => {\n  const json = pm.response.json();\n  pm.expect(json.value).to.eql(100);\n});',
  },
  {
    label: "Content-Type header is present",
    code: 'pm.test("Content-Type is present", () => {\n  pm.response.to.have.header("Content-Type");\n});',
  },
  {
    label: "Save value to environment",
    code: 'const json = pm.response.json();\npm.environment.set("token", json.token);',
  },
  {
    label: "Validate JSON schema",
    code: 'pm.test("Schema is valid", () => {\n  pm.response.to.have.jsonSchema({\n    type: "object",\n    required: ["id"],\n    properties: { id: { type: "number" } },\n  });\n});',
  },
  { label: "Stop the run", code: "pm.execution.setNextRequest(null);" },
];

export function ScriptEditor({
  value,
  onChange,
  kind,
}: {
  value: string;
  onChange: (v: string) => void;
  kind: "pre" | "test";
}) {
  const snippets = kind === "pre" ? PRE_SNIPPETS : TEST_SNIPPETS;
  return (
    <div className="flex h-full min-h-0 gap-2">
      <div className="min-w-0 flex-1 overflow-hidden rounded-md border">
        <CodeEditor
          value={value}
          language="javascript"
          variables={false}
          onChange={onChange}
          placeholder={
            kind === "pre"
              ? "// Runs before the request is sent"
              : '// Runs after the response is received\n// pm.test("Status is 200", () => pm.response.to.have.status(200));'
          }
        />
      </div>
      <div className="hidden w-52 shrink-0 flex-col gap-1 overflow-auto text-xs md:flex">
        <span className="px-1 text-[11px] font-medium text-muted-foreground">SNIPPETS</span>
        {snippets.map((s) => (
          <button
            key={s.label}
            className="rounded px-2 py-1 text-left text-primary hover:bg-accent"
            onClick={() => onChange(value ? `${value.replace(/\s*$/, "")}\n\n${s.code}\n` : `${s.code}\n`)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
