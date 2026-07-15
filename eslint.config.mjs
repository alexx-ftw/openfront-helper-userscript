import eslint from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

const strictRules = {
  ...sonarjs.configs.recommended.rules,
  complexity: ["error", 15],
  "max-depth": ["error", 4],
  "max-lines-per-function": [
    "error",
    { max: 150, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  "max-params": ["error", 5],
  "max-statements": ["error", 50],
  "no-console": ["error", { allow: ["warn", "error"] }],
  "no-constant-binary-expression": "error",
  "no-duplicate-imports": "error",
  "no-implicit-coercion": "error",
  "no-promise-executor-return": "error",
  "no-template-curly-in-string": "error",
  "no-unmodified-loop-condition": "error",
  "no-unreachable-loop": "error",
  "no-unused-private-class-members": "error",
  "prefer-const": "error",
  "require-atomic-updates": "error",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "openfront-helper.user.js",
      "coverage/**",
      "jscpd-report/**",
      "dist/**",
      "build/**",
    ],
  },
  {
    files: ["**/*.{js,mjs}"],
    ...eslint.configs.recommended,
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...strictRules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["engine/**/*.js"],
    languageOptions: { sourceType: "script" },
    rules: {
      // Engine files are classic scripts concatenated into a single ordered
      // scope. Cross-file globals are therefore intentional and cannot be
      // evaluated correctly one file at a time by ESLint.
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    plugins: { ...config.plugins, sonarjs },
    rules: { ...config.rules, ...strictRules },
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
  })),
);
