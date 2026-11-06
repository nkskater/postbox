import { defineConfig } from "vitest/config";

/** Browser tests: run against a production build with `npm run test:e2e` (build first). */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["e2e/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One shared server and database: keep files in sequence so tests do not trample each other.
    fileParallelism: false,
  },
});
