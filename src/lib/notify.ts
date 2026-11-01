/** Browser notification and sound when a long collection run finishes. */
import { getSetting } from "@/lib/settings/runtime";

export interface RunNotifyOptions {
  enabled: boolean;
  thresholdSeconds: number;
  sound: boolean;
}

export interface RunFinished {
  name: string;
  status: "passed" | "failed" | "cancelled" | "error";
  durationMs: number;
  totalRequests: number;
  failedRequests: number;
}

/** Whether to announce a finished run: only long ones, and only when the page is not being watched. */
export function shouldAnnounceRun(run: RunFinished, o: RunNotifyOptions, pageWatched: boolean): boolean {
  if (!o.enabled || pageWatched) return false;
  if (run.status === "cancelled") return false;
  return run.durationMs >= o.thresholdSeconds * 1000;
}

export function describeRun(run: RunFinished): { title: string; body: string } {
  const outcome =
    run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "stopped with an error";
  const seconds = Math.round(run.durationMs / 1000);
  const failures = run.failedRequests ? `, ${run.failedRequests} failed` : "";
  return {
    title: `Run ${outcome}: ${run.name}`,
    body: `${run.totalRequests} requests in ${seconds} s${failures}`,
  };
}

/** A short two-tone beep from the Web Audio API (no sound file needed). */
export function playChime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.16);
      osc.stop(ctx.currentTime + i * 0.16 + 0.14);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* audio may be blocked until the user interacts with the page */
  }
}

export function showBrowserNotification(title: string, body: string): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** Called when a run completes; applies the user's settings. */
export function notifyRunFinished(run: RunFinished) {
  const options: RunNotifyOptions = {
    enabled: !!getSetting<boolean>("notifications.runFinished"),
    thresholdSeconds: Number(getSetting<number>("notifications.runThresholdSeconds")) || 30,
    sound: !!getSetting<boolean>("notifications.sound"),
  };
  const watched = document.visibilityState === "visible" && document.hasFocus();
  if (!shouldAnnounceRun(run, options, watched)) return;
  const { title, body } = describeRun(run);
  showBrowserNotification(title, body);
  if (options.sound) playChime();
}
