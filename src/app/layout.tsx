import type { Metadata } from "next";
import "./globals.css";
import { headers } from "next/headers";
import { PREPAINT_SCRIPT } from "@/lib/settings/apply";
import { StrictScripts } from "@/components/app/StrictScripts";

export const metadata: Metadata = {
  title: "Postbox",
  description: "Self-hosted, lightweight API client",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Set by src/proxy.ts with the page's Content-Security-Policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved theme and accent before first paint to avoid a flash. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      </head>
      <body>
        <StrictScripts />
        {children}
      </body>
    </html>
  );
}
