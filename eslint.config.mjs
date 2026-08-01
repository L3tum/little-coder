// @ts-check

import ts from "@typescript-eslint/eslint-plugin";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export default tseslint.config(
  // Ignore generated, third-party, and non-code files
  {
    ignores: [
      "node_modules/**",
      ".pi/extensions/powerline-footer-unified/package.json",
      "site/**",
      "vendor/**",
      ".pytest_cache/**",
      "plans/**",
      "review-findings.md",
      "*.md",
      // JS-only extension files (not TypeScript)
      ".pi/extensions/subagent/runner-cli.js",
      ".pi/extensions/subagent/runner-events.js",
    ],
  },

  // TypeScript files
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    plugins: { "@typescript-eslint": ts },
    languageOptions: {
      parserOptions: {
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow console (used in extensions for logging)
      "no-console": "off",
      // TypeScript-specific overrides
      // Note: no-explicit-any and ban-ts-comment remain as warn due to
      // 300+ pre-existing violations across the codebase. They will be
      // enforced as error once existing violations are addressed.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-restricted-types": "off",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // JavaScript files
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": "error",
      "no-console": "off",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // Relax rules for test files
  {
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
