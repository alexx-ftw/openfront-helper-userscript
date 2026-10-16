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
  "no-restricted-syntax": [
    "error",
    {
      selector: "CatchClause",
      message: "Do not intercept exceptions; fix the cause and let failures propagate.",
    },
    {
      selector: "MemberExpression[property.name='catch']",
      message: "Do not use Promise.catch; await or return the promise and let rejection propagate.",
    },
  ],
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
      "openfront-engine/**",
      "openfront-helper.user.js",
      "openfront-helper.autobot.js",
      "openfront-helper.build-id.js",
      "coverage/**",
      "jscpd-report/**",
      "dist/**",
      "build/**",
      // Byte-preserved fragments; only the hash-verified orchestrator joins them.
      "test/*-parts/**",
      // SPLIT_GROUP chunks (scripts/build/sources.mjs); concatenated under the
      // legacy banner at build time, so only the whole file parses.
      "engine/ingame/auto-bot/legendary-planner/**",
      "engine/ingame/auto-bot/nuke-behavior/**",
      "engine/ingame/auto-bot/structure-behavior/**",
      // Scratch probe, not part of the suite.
      "test/tmp-legendary-probe.mjs",
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
  {
    files: ["engine/ingame/estate/**/*.js"],
    rules: {
      // Shared lexical scope (same rationale as the engine override above): per-file analysis cannot see cross-file let bindings (estatePanelOpen, estateSortDir, estateData, estateIntervalId) declared in estate/constants.js and mutated in estate/panel.js + estate/lifecycle.js.
      "prefer-const": "off",
      "sonarjs/no-implicit-global": "off",
    },
  },
  {
    files: ["engine/ingame/trade-policy/**/*.js"],
    rules: {
      // Shared lexical scope (same rationale as the engine override above): per-file analysis cannot see cross-file let bindings (_lastOpenFrontContextDiscoveryAt, _lastOpenFrontContextMissAt) declared in trade-policy/context.js nor the cross-file function bindings (isTeamGame, isAllowedTradePartnerForMyPlayer, getOpenFrontGameContext) consumed across trade-policy/players.js + partners.js + apply.js.
      "prefer-const": "off",
      "sonarjs/no-implicit-global": "off",
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
