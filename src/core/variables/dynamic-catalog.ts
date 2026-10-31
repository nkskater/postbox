import manifest from "./dynamic-catalog.json";

export const DYNAMIC_MANIFEST = manifest;
export type DynamicVariableName = keyof typeof manifest.variables | keyof typeof manifest.extensions;
export const DYNAMIC_VARIABLE_NAMES = Object.freeze([
  ...Object.keys(manifest.variables),
  ...Object.keys(manifest.extensions),
]) as readonly DynamicVariableName[];
const names = new Set<string>(DYNAMIC_VARIABLE_NAMES);
export function isDynamicVariable(name: string): name is DynamicVariableName {
  return names.has(name);
}
