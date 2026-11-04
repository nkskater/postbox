"use client";
// Replaces the root layout, so it renders its own <html> and relies on inline styles only.
import { CrashScreen } from "./crash-screen";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <CrashScreen error={error} reset={reset} />
      </body>
    </html>
  );
}
