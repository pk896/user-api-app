// .eslintrc.cjs
module.exports = {
  env: {
    browser: true, // for document/window in your EJS <script> blocks
    node: true,    // for Express, require, module.exports
    es2021: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:node/recommended',
    'prettier',
  ],
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'script', // using CommonJS
  },
  rules: {
    'no-console': 'off', // keep console.log for now
    'node/no-unsupported-features/es-syntax': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
};
