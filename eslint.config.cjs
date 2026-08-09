// eslint.config.cjs
'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const importPlugin = require('eslint-plugin-import');
const promisePlugin = require('eslint-plugin-promise');
const nPlugin = require('eslint-plugin-n');
const prettier = require('eslint-config-prettier');
const { FlatCompat } = require('@eslint/eslintrc');

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

module.exports = [
  /*
   * Files and directories that ESLint must not lint.
   *
   * Keep generated assets, dependencies, uploads and build
   * output outside application linting.
   */
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'public/**',
      'uploads/**',
      '.tmp/**',
      'spec/support/**',
    ],
  },

  /*
   * ESLint's core recommended JavaScript rules.
   */
  js.configs.recommended,

  /*
   * Import and Promise recommended rules.
   *
   * These packages still use shareable configurations here,
   * so FlatCompat safely converts them for flat config.
   */
  ...compat.extends(
    'plugin:import/recommended',
    'plugin:promise/recommended',
  ),

  /*
   * Recommended Node.js rules from eslint-plugin-n.
   */
  nPlugin.configs['flat/recommended'],

  /*
   * Main Kasyora JavaScript configuration.
   *
   * The application uses CommonJS:
   *
   * require(...)
   * module.exports = ...
   */
  {
    files: ['**/*.js', '**/*.cjs'],

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',

      /*
       * Kasyora contains both:
       *
       * - Node/Express JavaScript
       * - browser JavaScript used by views/client scripts
       *
       * Exposing both global sets preserves the behaviour of
       * the previous .eslintrc.cjs configuration.
       */
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },

    plugins: {
      import: importPlugin,
      promise: promisePlugin,
      n: nPlugin,
    },

    rules: {
      /*
       * Console output is intentionally allowed throughout the
       * Express application for server logging and diagnostics.
       */
      'no-console': 'off',

      /*
       * Warn about unused variables without failing the entire
       * lint command.
       *
       * Prefix intentionally unused arguments/variables with "_".
       *
       * Example:
       *
       * function handler(_req, res) {}
       */
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      /*
       * process.exit() should normally not be used by ordinary
       * application code.
       *
       * Explicit infrastructure files are exempted below.
       */
      'n/no-process-exit': 'error',

      /*
       * The Kasyora application has a large CommonJS module tree.
       *
       * Node itself remains authoritative for runtime module
       * resolution rather than eslint-plugin-import.
       */
      'import/no-unresolved': 'off',

      /*
       * Application dependencies may include runtime packages
       * and project-local modules that eslint-plugin-n otherwise
       * interprets as unpublished requires.
       */
      'n/no-unpublished-require': 'off',

      /*
       * Preserve the intent of the old:
       *
       * node/no-unsupported-features/es-syntax = off
       *
       * eslint-plugin-n is the maintained successor to the old
       * eslint-plugin-node rule namespace.
       */
      'n/no-unsupported-features/es-syntax': 'off',
    },
  },

  /*
   * ESLint's own configuration file legitimately requires
   * development-only ESLint packages.
   */
  {
    files: ['eslint.config.cjs'],

    rules: {
      'n/no-unpublished-require': 'off',
    },
  },

  /*
   * Infrastructure/bootstrap files may intentionally terminate
   * the Node process when startup requirements are not satisfied.
   */
  {
    files: [
      'config/validateEnv.js',
      'config/db.js',
    ],

    rules: {
      'n/no-process-exit': 'off',
    },
  },

  /*
   * Jasmine/test globals.
   */
  {
    files: [
      '**/*.spec.js',
      '**/*.test.js',
      'spec/**/*.js',
    ],

    languageOptions: {
      globals: {
        ...globals.node,
        jasmine: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        expect: 'readonly',
      },
    },
  },

  /*
   * Keep this LAST.
   *
   * eslint-config-prettier disables ESLint formatting rules that
   * would conflict with Prettier.
   */
  prettier,
];
