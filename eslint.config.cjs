// eslint.config.cjs — flat config (works with ESLint 9+)
const js = require("@eslint/js");
const globals = require("globals");

const importPlugin = require("eslint-plugin-import");
const promisePlugin = require("eslint-plugin-promise");
const nPlugin = require("eslint-plugin-n");
const prettier = require("eslint-config-prettier");

const { FlatCompat } = require("@eslint/eslintrc");
const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = [
  // 0) Ignore paths
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "public/**",
      "uploads/**",
      ".tmp/**",
      // 👇 ignore Jasmine's ESM bootstrap file
      "spec/support/**",
    ],
  },

  // 1) Base flat config
  js.configs.recommended,

  // 2) Bring in old-style shareable configs via FlatCompat
  ...compat.extends("plugin:import/recommended", "plugin:promise/recommended"),

  // 3) Node plugin has a flat preset; use it directly
  nPlugin.configs["flat/recommended"],

  // 4) Your project rules + plugin objects (flat requires object, not array)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: {
      import: importPlugin,
      promise: promisePlugin,
      n: nPlugin,
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "n/no-process-exit": "error",
      "import/no-unresolved": "off",
      "n/no-unpublished-require": "off",
    },
  },

  // 5) Don’t nag about unpublished require inside this config file
  {
    files: ["eslint.config.cjs"],
    rules: {
      "n/no-unpublished-require": "off",
    },
  },

  // 6) Allow process.exit in specific scripts (validateEnv / db)
  {
    files: ["config/validateEnv.js", "utils/db.js"],
    rules: {
      "n/no-process-exit": "off",
    },
  },

  // 7) Jasmine test files: describe/it/expect globals
  {
    files: ["**/*.spec.js", "**/*.test.js", "spec/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        jasmine: "readonly",
        describe: "readonly",
        it: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        expect: "readonly",
      },
    },
  },

  // 8) Prettier last — disables conflicting stylistic rules
  prettier,
];
