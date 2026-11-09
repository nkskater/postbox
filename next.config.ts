import type { NextConfig } from "next";

const SECURITY_HEADER_SOURCE = "/((?!mock/|hook/|capture/).*)";
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

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
  // Default protection for the app and API. The public mock, webhook and capture receivers are
  // left alone: they set their own headers or relay the upstream response unchanged.
  async headers() {
    return [{ source: SECURITY_HEADER_SOURCE, headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
