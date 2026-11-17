"use client";
import type { ReactNode } from "react";
import { featureLabel, featureSettingKey, type FeatureId } from "@/core/features";
import { useSettings } from "@/stores/settings";

/** Whether a feature area is switched on (Settings → Features). Areas are on until switched off. */
export function useFeature(id: FeatureId): boolean {
  return useSettings((s) => s.values[featureSettingKey(id)]) !== false;
}

/** Renders its children only while the feature area is on; otherwise a short notice (or nothing). */
export function FeatureGate({
  feature,
  children,
  notice = false,
}: {
  feature: FeatureId;
  children: ReactNode;
  /** Show why the content is missing instead of rendering nothing (for whole tabs). */
  notice?: boolean;
}) {
  const on = useFeature(feature);
  if (on) return <>{children}</>;
  if (!notice) return null;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground" data-testid="feature-off">
        {featureLabel(feature)} is switched off on this server. An administrator can switch it on under
        Settings → Features.
      </p>
    </div>
  );
}
