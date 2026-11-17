"use client";
import {
  FEATURE_IDS,
  FEATURE_PRESETS,
  featureSettingKey,
  matchingPreset,
  presetSwitches,
} from "@/core/features";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";

/** Applies a group of feature switches in one step and shows which preset the switches match. */
export function FeaturePresets({ isAdmin }: { isAdmin: boolean }) {
  const values = useSettings((s) => s.values);
  const envLocked = useSettings((s) => s.envLocked);
  const setMany = useSettings((s) => s.setMany);
  const enabled = new Set(FEATURE_IDS.filter((id) => values[featureSettingKey(id)] !== false));
  const current = matchingPreset(enabled);
  const pinned = FEATURE_IDS.filter((id) => envLocked[featureSettingKey(id)]);

  const apply = (id: string) => {
    const preset = FEATURE_PRESETS.find((p) => p.id === id)!;
    // Switches pinned by an environment variable cannot change, so they are left out.
    const changes = Object.fromEntries(
      Object.entries(presetSwitches(preset)).filter(([key]) => !envLocked[key]),
    );
    void setMany(changes);
  };

  return (
    <div className="mb-4 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Preset</h3>
        <span className="text-xs text-muted-foreground" data-testid="feature-preset-current">
          Current: {current?.label ?? "Custom"}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Apply a group of switches at once. You can still change single switches below afterwards. Data in
        areas that are switched off is kept.
      </p>
      <div role="radiogroup" aria-label="Feature preset" className="mt-3 grid gap-2 sm:grid-cols-2">
        {FEATURE_PRESETS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={current?.id === p.id}
            disabled={!isAdmin}
            onClick={() => apply(p.id)}
            className={cn(
              "rounded-md border p-3 text-left text-xs transition-colors disabled:opacity-60",
              current?.id === p.id ? "border-primary bg-accent" : "hover:bg-accent/50",
            )}
          >
            <div className="text-sm font-medium">{p.label}</div>
            <div className="mt-0.5 text-muted-foreground">{p.description}</div>
          </button>
        ))}
      </div>
      {pinned.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {pinned.length === 1 ? "One switch is" : `${pinned.length} switches are`} set by an environment
          variable and not changed by a preset.
        </p>
      )}
    </div>
  );
}
