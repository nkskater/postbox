"use client";
import { useState } from "react";
import type { RequestDef } from "@/core/types";
import type { ContractDiagnostic } from "@/core/contracts/model";
import { parseContract, validateDraft, validateExample } from "@/core/contracts/validate";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { Button } from "@/components/ui/button";

const sample = {
  parameters: [
    {
      in: "query",
      name: "limit",
      required: false,
      description: "Maximum number of results",
      schema: { type: "integer", minimum: 1, maximum: 100 },
    },
  ],
  responseStatus: [200],
  responseBody: {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array", items: { type: "object" } } },
  },
};
export function ContractEditor({
  request,
  onChange,
  actual,
}: {
  request: RequestDef;
  onChange: (contract: RequestDef["contract"]) => void;
  actual?: ContractDiagnostic[];
}) {
  const [text, setText] = useState(JSON.stringify(request.contract ?? sample, null, 2));
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ name: string; diagnostics: ContractDiagnostic[] }[] | null>(null);
  const applied = request.contract ? JSON.stringify(request.contract, null, 2) : "";
  const pending = text !== applied;
  const apply = () => {
    try {
      const value = parseContract(JSON.parse(text));
      onChange(value);
      setText(JSON.stringify(value, null, 2));
      setError("");
      setReport(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Invalid contract");
    }
  };
  const validate = () => {
    try {
      setReport([
        { name: "Draft request", diagnostics: validateDraft(request) },
        ...(request.examples ?? []).map((example) => ({
          name: `Example: ${example.name}`,
          diagnostics: validateExample(request.contract!, example),
        })),
      ]);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Invalid contract");
    }
  };
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        Declare query, header and path parameters and JSON body schemas. Apply the definition, then save the
        request. Sends validate the prepared HTTP request and response; failures appear in Test Results. Draft
        checks use no network and defer unresolved templates.
      </p>
      <div aria-label="Contract definition" className="h-64 overflow-auto rounded border">
        <CodeEditor value={text} onChange={setText} language="json" variables={false} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={apply}>
          Apply contract
        </Button>
        <Button size="sm" variant="outline" disabled={!request.contract || pending} onClick={validate}>
          Validate draft &amp; examples
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(null);
            setReport(null);
            setError("");
          }}
        >
          Remove contract
        </Button>
        <span role="status" className="text-muted-foreground">
          {pending
            ? "Definition has not been applied"
            : request.contract
              ? "Definition applied to request draft"
              : "No contract applied"}
        </span>
      </div>
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {error}
        </p>
      )}
      {!!request.contract?.parameters.length && (
        <table className="w-full text-left">
          <caption className="mb-1 text-left font-medium">Parameter documentation</caption>
          <thead>
            <tr>
              <th>Location / name</th>
              <th>Required</th>
              <th>Schema and description</th>
            </tr>
          </thead>
          <tbody>
            {request.contract.parameters.map((parameter) => (
              <tr className="border-t" key={`${parameter.in}:${parameter.name}`}>
                <td className="py-2">
                  {parameter.in} / {parameter.name}
                </td>
                <td>{parameter.required ? "Yes" : "No"}</td>
                <td>
                  <code>{JSON.stringify(parameter.schema)}</code>
                  <p>{parameter.description}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(report ?? [])
        .concat(actual ? [{ name: "Last HTTP execution", diagnostics: actual }] : [])
        .map((group, i) => (
          <div key={i}>
            <h3 className="mb-1 font-medium">{group.name}</h3>
            {!group.diagnostics.length ? (
              <p>No applicable constraints to check.</p>
            ) : (
              <ul className="space-y-1">
                {group.diagnostics.map((item, j) => (
                  <li
                    key={j}
                    className={
                      item.status === "error"
                        ? "text-destructive"
                        : item.status === "passed"
                          ? "text-success"
                          : "text-muted-foreground"
                    }
                  >
                    {item.status.toUpperCase()} · {item.location}: {item.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      <p className="text-muted-foreground">
        JSON Schema supports types, required fields, enum/const, numeric/string/array/object bounds,
        properties, additionalProperties, items, allOf/anyOf/oneOf/not and local #/ references via definitions
        or $defs. Remote references, cyclic schema references, formats and regular expressions are
        unavailable. Schemas are limited to 64 KiB, 512 nodes and depth 32; values to 1 MiB and depth 64.
        Query arrays use repeated keys; parameter values are coerced for type checks only. JSON bodies are not
        coerced. Path parameters use pathTemplate such as /pets/&#123;id&#125;. Binary, omitted and truncated
        examples are deferred.
      </p>
    </div>
  );
}
