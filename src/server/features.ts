import { featureLabel, featureOfPath, FEATURE_IDS, featureSettingKey, type FeatureId } from "@/core/features";
import { FEATURE_SETTINGS, resolveSettings } from "@/lib/settings/registry";
import { getSqlite } from "./db";
import { HttpError } from "./errors";

/**
 * Feature switches as currently saved and pinned. Read on every use (one small query), so a change
 * under Settings → Features applies to the next request without a restart.
 */
export function disabledFeatures(env: Record<string, string | undefined> = process.env): Set<FeatureId> {
  const rows = getSqlite()
    .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'features.%'")
    .all() as {
    key: string;
    value: string;
  }[];
  const saved: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      saved[row.key] = JSON.parse(row.value);
    } catch {
      /* an unreadable value falls back to the default (on) */
    }
  }
  const { values } = resolveSettings(saved, env, FEATURE_SETTINGS);
  return new Set(FEATURE_IDS.filter((id) => values[featureSettingKey(id)] === false));
}

export function featureEnabled(id: FeatureId, env?: Record<string, string | undefined>): boolean {
  return !disabledFeatures(env).has(id);
}

export function featureOffError(id: FeatureId) {
  return new HttpError(
    404,
    `${featureLabel(id)} is switched off on this server. An administrator can switch it on under Settings → Features.`,
  );
}

/** Throw 404 when the area is switched off. */
export function requireFeature(id: FeatureId) {
  if (!featureEnabled(id)) throw featureOffError(id);
}

/** Throw 404 when the path belongs to an area that is switched off. */
export function requireFeatureForPath(pathname: string) {
  const id = featureOfPath(pathname);
  if (id) requireFeature(id);
}
