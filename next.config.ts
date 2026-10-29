import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native / WASM packages must be loaded from node_modules at runtime rather than bundled.
  serverExternalPackages: ["better-sqlite3", "quickjs-emscripten", "@jitl/quickjs-wasmfile-release-sync"],
  // Make sure the QuickJS WASM binary and DB migrations end up in the standalone bundle.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**", "./drizzle/**"],
  },
  poweredByHeader: false,
};

export default nextConfig;
