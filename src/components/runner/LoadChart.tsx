"use client";
/** Throughput and p95 latency over time, as two small SVG line charts. */
import type { SeriesPoint } from "@/core/load/metrics";

function Line({
  points,
  color,
  label,
  unit,
}: {
  points: { x: number; y: number }[];
  color: string;
  label: string;
  unit: string;
}) {
  const w = 320;
  const h = 90;
  const pad = 4;
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y));
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(pad + (p.x / maxX) * (w - 2 * pad)).toFixed(1)},${(h - pad - (p.y / maxY) * (h - 2 * pad)).toFixed(1)}`,
    )
    .join(" ");
  const last = points.at(-1);
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span>
          {last ? `${Math.round(last.y * 10) / 10} ${unit}` : "–"} · peak {Math.round(maxY * 10) / 10}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-24 w-full rounded border bg-muted/20"
        role="img"
        aria-label={`${label} over time`}
      >
        {path && <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />}
      </svg>
    </figure>
  );
}

export function LoadChart({ series }: { series: SeriesPoint[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      <Line
        label="Throughput"
        unit="req/s"
        color="var(--chart-1, #4f8ff7)"
        points={series.map((p) => ({ x: p.t, y: p.rps }))}
      />
      <Line
        label="p95 latency"
        unit="ms"
        color="var(--chart-2, #e8833a)"
        points={series.map((p) => ({ x: p.t, y: p.p95 }))}
      />
      <Line
        label="Virtual users"
        unit="VUs"
        color="var(--chart-3, #5bb974)"
        points={series.map((p) => ({ x: p.t, y: p.vus }))}
      />
    </div>
  );
}
