"use client";
import { CrashScreen } from "./crash-screen";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrashScreen error={error} reset={reset} />;
}
