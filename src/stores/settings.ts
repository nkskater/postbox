"use client";
/**
 * Client store for app settings: loads from /api/settings, applies appearance live,
 * and persists changes (optimistically) back to the server.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { defaultValues, type SettingValue } from "@/lib/settings/registry";
import { applyAppearance, computeAppearance } from "@/lib/settings/apply";
import type { EnvSetting, SettingsPayload } from "@/server/settings";
import { useApp } from "./app";
import { setRuntimeSettings } from "@/lib/settings/runtime";

interface SettingsState {
  loaded: boolean;
  values: Record<string, SettingValue>;
  saved: Record<string, unknown>;
  envLocked: Record<string, string>;
  environment: EnvSetting[];
  /** Search text on the Settings page (set by the command palette to jump to a setting). */
  query: string;
  init(): Promise<void>;
  set(key: string, value: SettingValue): Promise<void>;
  reset(keys: string[]): Promise<void>;
  importFile(data: Record<string, unknown>): Promise<void>;
  setQuery(q: string): void;
}

function apply(values: Record<string, SettingValue>) {
  setRuntimeSettings(values);
  const computed = computeAppearance(values);
  applyAppearance(computed);
  // Editors, toasts etc. read the resolved theme from the app store.
  if (useApp.getState().theme !== computed.theme) useApp.setState({ theme: computed.theme });
}

let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function watchSystemTheme() {
  if (systemListener || typeof window === "undefined" || !window.matchMedia) return;
  systemListener = () => {
    const { values } = useSettings.getState();
    if (values["appearance.theme"] === "system") apply(values);
  };
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", systemListener);
}

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<SettingsPayload & { skipped?: string[] }> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  loaded: false,
  values: defaultValues(),
  saved: {},
  envLocked: {},
  environment: [],
  query: "",

  async init() {
    watchSystemTheme();
    try {
      const data = await request("GET", "/api/settings");
      set({
        loaded: true,
        values: data.values,
        saved: data.saved,
        envLocked: data.envLocked,
        environment: data.environment,
      });
      apply(data.values);
      // Tabs were rehydrated from storage before settings loaded; drop them if restore is off.
      if (data.values["tabs.restore"] === false) useApp.setState({ tabs: [], activeTabId: null });
    } catch {
      set({ loaded: true });
      apply(get().values);
    }
  },

  async set(key, value) {
    const prev = get();
    const values = { ...prev.values, [key]: value };
    set({ values, saved: { ...prev.saved, [key]: value } });
    apply(values);
    try {
      const data = await request("PATCH", "/api/settings", { values: { [key]: value } });
      set({ values: data.values, saved: data.saved });
    } catch (err) {
      set({ values: prev.values, saved: prev.saved });
      apply(prev.values);
      toast.error(`Could not save setting: ${(err as Error).message}`);
    }
  },

  async reset(keys) {
    if (!keys.length) return;
    try {
      const data = await request("PATCH", "/api/settings", {
        values: Object.fromEntries(keys.map((k) => [k, null])),
      });
      set({ values: data.values, saved: data.saved });
      apply(data.values);
    } catch (err) {
      toast.error((err as Error).message);
    }
  },

  async importFile(file) {
    const settings = (file.settings ?? file) as Record<string, unknown>;
    const data = await request("POST", "/api/settings/import", { settings });
    set({ values: data.values, saved: data.saved });
    apply(data.values);
    if (data.skipped?.length)
      toast.warning(`Imported with ${data.skipped.length} skipped entries: ${data.skipped.join("; ")}`);
    else toast.success("Settings imported");
  },

  setQuery: (query) => set({ query }),
}));

/** Read a single setting value (re-renders only when it changes). */
export function useSetting<T extends SettingValue>(key: string): T {
  return useSettings((s) => s.values[key]) as T;
}
