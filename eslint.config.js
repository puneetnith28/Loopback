import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { boundaryConfigs } from "./eslint.config.boundaries.js";

export default tseslint.config(
  // `video/` is git-ignored working material for the demo film, not part of the project.
  { ignores: ["**/dist/**", "**/dist-design/**", "**/node_modules/**", "coverage/**", "video/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          "./apps/switch-gate/tsconfig.json",
          "./apps/console-api/tsconfig.json",
          "./apps/console/tsconfig.json",
          "./packages/contracts/tsconfig.json",
          "./packages/console-contracts/tsconfig.json",
          "./tsconfig.tests.json",
        ],
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
    // Console (frontend): React hooks rules; untrusted data is never rendered as HTML.
    files: ["apps/console/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-syntax": ["error", {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: "The console renders untrusted data as text only (DESIGN.md §5).",
      }],
    },
  },
  {
    files: ["apps/console/public/**/*.js"],
    languageOptions: { globals: { window: "readonly", document: "readonly" } },
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
