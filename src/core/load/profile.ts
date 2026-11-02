/**
 * Load profiles: how many virtual users (VUs) run at each moment of a test. Pure functions, no I/O.
 *
 * - constant: `vus` for `durationSec`.
 * - ramp:     linear segments through `stages` (each `target` is reached at the end of its duration), starting
 *             from `startVus`. Use a stage with a tiny duration for a step.
 * - spike:    `baseVus`, jumping to `spikeVus` from `spikeAtSec` for `spikeForSec`, then back, for `durationSec`.
 */
import { z } from "zod";

export const MAX_STAGES = 20;

const vus = z.number().int().min(0).max(100_000);
const seconds = z.number().int().min(1).max(86_400);

export const profileSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("constant"), vus: vus.min(1), durationSec: seconds }),
  z.object({
    type: z.literal("ramp"),
    startVus: vus.default(0),
    stages: z
      .array(z.object({ durationSec: seconds, target: vus }))
      .min(1)
      .max(MAX_STAGES),
  }),
  z
    .object({
      type: z.literal("spike"),
      baseVus: vus.min(1),
      spikeVus: vus.min(1),
      durationSec: seconds,
      spikeAtSec: z.number().int().min(0).max(86_400),
      spikeForSec: seconds,
    })
    .refine((p) => p.spikeVus >= p.baseVus, {
      message: "spikeVus must be at least baseVus",
      path: ["spikeVus"],
    })
    .refine((p) => p.spikeAtSec + p.spikeForSec <= p.durationSec, {
      message: "The spike must end before the test does",
      path: ["spikeForSec"],
    }),
]);
export type LoadProfile = z.infer<typeof profileSchema>;

export function profileDurationSec(profile: LoadProfile): number {
  if (profile.type === "ramp") return profile.stages.reduce((n, s) => n + s.durationSec, 0);
  return profile.durationSec;
}

/** The highest VU count the profile asks for. */
export function profilePeakVus(profile: LoadProfile): number {
  switch (profile.type) {
    case "constant":
      return profile.vus;
    case "ramp":
      return Math.max(profile.startVus, ...profile.stages.map((s) => s.target));
    case "spike":
      return profile.spikeVus;
  }
}

/** Desired VU count `t` seconds into the test (0 once it is over). */
export function targetVus(profile: LoadProfile, t: number): number {
  if (t < 0 || t >= profileDurationSec(profile)) return 0;
  switch (profile.type) {
    case "constant":
      return profile.vus;
    case "spike":
      return t >= profile.spikeAtSec && t < profile.spikeAtSec + profile.spikeForSec
        ? profile.spikeVus
        : profile.baseVus;
    case "ramp": {
      let start = 0;
      let from = profile.startVus;
      for (const stage of profile.stages) {
        if (t < start + stage.durationSec)
          return Math.round(from + ((stage.target - from) * (t - start)) / stage.durationSec);
        start += stage.durationSec;
        from = stage.target;
      }
      return 0;
    }
  }
}

export interface LoadLimits {
  maxVus: number;
  maxDurationSec: number;
  /** Total requests after which the test stops. */
  maxRequests: number;
}

export const DEFAULT_LOAD_LIMITS: LoadLimits = { maxVus: 100, maxDurationSec: 600, maxRequests: 200_000 };

/** Reasons a profile exceeds the configured ceilings (empty when it fits). */
export function profileViolations(profile: LoadProfile, limits: LoadLimits): string[] {
  const problems: string[] = [];
  if (profilePeakVus(profile) > limits.maxVus)
    problems.push(
      `The profile needs ${profilePeakVus(profile)} virtual users; the limit is ${limits.maxVus}`,
    );
  if (profileDurationSec(profile) > limits.maxDurationSec)
    problems.push(
      `The profile runs ${profileDurationSec(profile)} s; the limit is ${limits.maxDurationSec} s`,
    );
  return problems;
}

/** A short description, e.g. "ramp 0 → 50 → 50 → 0 VUs over 90 s". */
export function describeProfile(profile: LoadProfile): string {
  const d = profileDurationSec(profile);
  switch (profile.type) {
    case "constant":
      return `${profile.vus} VUs for ${d} s`;
    case "spike":
      return `${profile.baseVus} VUs with a spike to ${profile.spikeVus} at ${profile.spikeAtSec} s for ${profile.spikeForSec} s (${d} s)`;
    case "ramp":
      return `ramp ${[profile.startVus, ...profile.stages.map((s) => s.target)].join(" → ")} VUs over ${d} s`;
  }
}

/** `30`, `30s`, `5m` or `1h` as seconds, or null when it is not a duration between 1 second and 24 hours. */
export function parseDurationSec(text: string): number | null {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? "s"] as number);
  return n >= 1 && n <= 86_400 ? n : null;
}
