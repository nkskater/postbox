"use client";
/**
 * Browser-side settings the Content-Security-Policy needs (LAB-277). zod otherwise probes for
 * `new Function` support, which the policy (no 'unsafe-eval') reports as a violation; its
 * interpreted validation is used either way.
 */
import { config } from "zod";

config({ jitless: true });

export function StrictScripts() {
  return null;
}
