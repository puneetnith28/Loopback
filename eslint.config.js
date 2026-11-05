import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { boundaryConfigs } from "./eslint.config.boundaries.js";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./apps/switch-gate/tsconfig.json", "./apps/console-api/tsconfig.json", "./packages/contracts/tsconfig.json", "./packages/console-contracts/tsconfig.json", "./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Stand-alone Node scripts (no TypeScript project): Node globals only.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  ...boundaryConfigs,
);
