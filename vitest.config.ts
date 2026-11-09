import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The extension host API does not exist outside VS Code; tests run it against a small fake.
      vscode: path.resolve(import.meta.dirname, "tests/helpers/fake-vscode.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    globalSetup: ["tests/global-setup.ts"],
  },
});
