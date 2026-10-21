import js from '@eslint/js';
import globals from 'globals';

export default [
  {ignores: ['node_modules/', 'dist/']},
  js.configs.recommended,
  {
    files: ['extension/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {...globals.browser, ...globals.webextensions},
    },
  },
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', '*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {...globals.node, chrome: 'readonly'},
    },
  },
  {
    // Puppeteer callbacks run inside the browser.
    files: ['test/e2e/**/*.mjs', 'scripts/screenshots.mjs'],
    languageOptions: {globals: {...globals.node, ...globals.browser, chrome: 'readonly'}},
  },
  {
    rules: {
      'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}],
      'no-empty': ['error', {allowEmptyCatch: true}],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', {null: 'ignore'}],
    },
  },
];
