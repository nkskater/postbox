import type { Metadata } from "next";
import "./globals.css";
import { PREPAINT_SCRIPT } from "@/lib/settings/apply";

export const metadata: Metadata = {
  title: "Postbox",
  description: "Self-hosted, lightweight API client",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved theme and accent before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
