import YAML from "yaml";
export type OpenApiObject = Record<string, unknown>;

export function parseSpec(text: string): OpenApiObject {
  const input = text.trim();
  return (input.startsWith("{") ? JSON.parse(input) : YAML.parse(input)) as OpenApiObject;
}
export function isOpenApi(data: unknown): data is OpenApiObject {
  const value = data as OpenApiObject;
  return (
    !!value &&
    typeof value === "object" &&
    (typeof value.openapi === "string" || typeof value.swagger === "string") &&
    !!value.paths
  );
}
