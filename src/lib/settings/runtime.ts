/**
 * Current setting values for non-React code (e.g. the app store), without importing
 * the settings store (which would create an import cycle). Updated by the settings store.
 */
import { defaultValues, type SettingValue } from "./registry";

let current: Record<string, SettingValue> = defaultValues();

export function setRuntimeSettings(values: Record<string, SettingValue>) {
  current = values;
}

export function getSetting<T extends SettingValue>(key: string): T {
  return current[key] as T;
}
