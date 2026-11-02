import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native / WASM packages must be loaded from node_modules at runtime rather than bundled.
  // linkedom (and its CSS parser) is 1.3 MB of source. Bundled, the compiler copies it into every route
  // chunk that reaches the executor and the server loads every copy at startup; external, it loads once.
  serverExternalPackages: [
    "better-sqlite3",
    "quickjs-emscripten",
    "@jitl/quickjs-wasmfile-release-sync",
    "linkedom",
  ],
  // Make sure the QuickJS WASM binary and DB migrations end up in the standalone bundle.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**", "./drizzle/**"],
  },
  poweredByHeader: false,
};

export default nextConfig;
