import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "extensions/*/dist/**",
    "drizzle/**",
    "next-env.d.ts",
    "desktop/node_modules/**",
    "desktop/payload/**",
    "desktop/src-tauri/target/**",
    "desktop/src-tauri/gen/**",
  ]),
]);

export default eslintConfig;
