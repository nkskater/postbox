"use client";
/** Custom colors for HTTP methods and status codes (Appearance). */
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSetting, useSettings } from "@/stores/settings";
import {
  DEFAULT_METHOD_COLORS,
  METHODS,
  STATUS_KEYS,
  STATUS_LABELS,
  STATUS_PICKER_DEFAULTS,
  parseColors,
  serializeColors,
  type MethodName,
  type StatusKey,
} from "@/lib/colors";

function ColorRow({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className="flex-1 font-mono text-xs" style={{ color: value ?? fallback }}>
        {label}
      </span>
      <input
        type="color"
        aria-label={`${label} color`}
        className="h-7 w-10 cursor-pointer rounded border bg-transparent"
        value={value ?? fallback}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={`Reset ${label} color`}
        title="Use the default color"
        disabled={!value}
        onClick={() => onChange(null)}
      >
        <RotateCcw className="size-3.5" />
      </Button>
    </div>
  );
}

export function ColorSettings() {
  const methodRaw = useSetting<string>("appearance.methodColors");
  const statusRaw = useSetting<string>("appearance.statusColors");
  const methods = parseColors(methodRaw, METHODS);
  const status = parseColors(statusRaw, STATUS_KEYS);
  const save = (key: string, value: string) => void useSettings.getState().set(key, value);
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-sm font-medium">HTTP method colors</h3>
        <div className="divide-y rounded-lg border">
          {METHODS.map((m: MethodName) => (
            <ColorRow
              key={m}
              label={m}
              value={methods[m]}
              fallback={DEFAULT_METHOD_COLORS[m]}
              onChange={(v) => {
                const next = { ...methods };
                if (v) next[m] = v;
                else delete next[m];
                save("appearance.methodColors", serializeColors(next));
              }}
            />
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">Status colors</h3>
        <div className="divide-y rounded-lg border">
          {STATUS_KEYS.map((k: StatusKey) => (
            <ColorRow
              key={k}
              label={STATUS_LABELS[k]}
              value={status[k]}
              fallback={STATUS_PICKER_DEFAULTS[k]}
              onChange={(v) => {
                const next = { ...status };
                if (v) next[k] = v;
                else delete next[k];
                save("appearance.statusColors", serializeColors(next));
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
