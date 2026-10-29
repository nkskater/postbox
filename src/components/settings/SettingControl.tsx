"use client";
/**
 * Renders the right control for a registry setting and saves changes through the settings store.
 */
import { useRef, useState } from "react";
import { AlertTriangle, Check, Pipette } from "lucide-react";
import type { SettingDef, SettingValue } from "@/lib/settings/registry";
import { ACCENT_PRESETS, accentTokens } from "@/lib/settings/accent";
import { css, oklchToHex, parseHex } from "@/lib/color";
import { useSettings } from "@/stores/settings";
import { useApp } from "@/stores/app";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function SettingControl({
  def,
  value,
  disabled,
}: {
  def: SettingDef;
  value: SettingValue;
  disabled?: boolean;
}) {
  const save = useSettings((s) => s.set);
  switch (def.type) {
    case "boolean":
      return (
        <Switch
          checked={!!value}
          disabled={disabled}
          onCheckedChange={(v) => save(def.key, v)}
          aria-label={def.label}
        />
      );
    case "select":
      if (def.options.length <= 4) {
        return (
          <div role="radiogroup" aria-label={def.label} className="inline-flex rounded-md border p-0.5">
            {def.options.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={value === o.value}
                disabled={disabled}
                onClick={() => save(def.key, o.value)}
                className={cn(
                  "rounded px-3 py-1 text-xs transition-colors",
                  value === o.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      }
      return (
        <Select value={String(value)} disabled={disabled} onValueChange={(v) => save(def.key, v)}>
          <SelectTrigger size="sm" className="w-48 text-xs" aria-label={def.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "number":
      // Keyed by the saved value so external changes (reset, import) reset the local slider state.
      return <NumberControl key={String(value)} def={def} value={Number(value)} disabled={disabled} />;
    case "accent":
      return <AccentPicker value={String(value)} disabled={disabled} />;
  }
}

/** Slider that previews instantly and saves once dragging pauses. */
function NumberControl({
  def,
  value,
  disabled,
}: {
  def: Extract<SettingDef, { type: "number" }>;
  value: number;
  disabled?: boolean;
}) {
  const save = useSettings((s) => s.set);
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = (v: number) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(def.key, v), 250);
  };
  return (
    <div className="flex w-56 items-center gap-3">
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step ?? 1}
        value={local}
        disabled={disabled}
        aria-label={def.label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary"
      />
      <span className="w-12 text-right text-xs tabular-nums">
        {local}
        {def.unit}
      </span>
    </div>
  );
}

function AccentPicker({ value, disabled }: { value: string; disabled?: boolean }) {
  const theme = useApp((s) => s.theme);
  const isCustom = value.startsWith("#");
  const tokens = accentTokens(value, theme);
  const currentHex = isCustom ? value : oklchToHex(tokens.primary);
  // Remount on preset changes only, so the native color picker stays open while dragging a custom color.
  return (
    <AccentPickerInner
      key={isCustom ? "custom" : currentHex}
      value={value}
      currentHex={currentHex}
      disabled={disabled}
    />
  );
}

function AccentPickerInner({
  value,
  currentHex,
  disabled,
}: {
  value: string;
  currentHex: string;
  disabled?: boolean;
}) {
  const save = useSettings((s) => s.set);
  const theme = useApp((s) => s.theme);
  const isCustom = value.startsWith("#");
  const tokens = accentTokens(value, theme);
  const [hex, setHex] = useState(currentHex);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveCustom = (v: string, delay = 0) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save("appearance.accent", v.toLowerCase()), delay);
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <div className="grid grid-cols-10 gap-1.5" role="radiogroup" aria-label="Accent color presets">
        {ACCENT_PRESETS.map((p) => {
          const t = accentTokens(p.id, theme);
          const selected = value === p.id;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={selected}
              aria-label={p.label}
              title={p.label}
              disabled={disabled}
              onClick={() => save("appearance.accent", p.id)}
              className={cn(
                "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110",
                selected && "ring-2 ring-foreground",
              )}
              style={{ background: css(t.primary), color: css(t.foreground) }}
            >
              {selected && <Check className="size-3.5" />}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label
          className={cn(
            "relative flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border",
            isCustom && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
          )}
          style={{ background: isCustom ? value : undefined }}
          title="Pick a custom color"
        >
          {!isCustom && <Pipette className="size-3.5 text-muted-foreground" />}
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={parseHex(hex) ? hex : "#d4915e"}
            disabled={disabled}
            onChange={(e) => {
              setHex(e.target.value);
              saveCustom(e.target.value, 200);
            }}
          />
        </label>
        <Input
          value={hex}
          disabled={disabled}
          onChange={(e) => {
            setHex(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) saveCustom(e.target.value, 300);
          }}
          className="h-7 w-28 font-mono text-xs"
          aria-label="Custom accent hex color"
          placeholder="#rrggbb"
        />
        <span className="text-xs text-muted-foreground">
          {isCustom ? "Custom color" : "Or pick any custom color"}
        </span>
      </div>
      {(tokens.textContrast < 4.5 || tokens.backgroundContrast < 3) && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {tokens.textContrast < 4.5
            ? `Button text contrast is ${tokens.textContrast.toFixed(1)}:1 (4.5:1 recommended).`
            : `This color has low contrast (${tokens.backgroundContrast.toFixed(1)}:1) against the background, so links and focus rings may be hard to see.`}
        </p>
      )}
    </div>
  );
}
