// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist', '**/coverage', '**/node_modules', 'playwright-report', 'test-results']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit list so every linted file (including config files) gets type info.
        project: [
          './tsconfig.tools.json',
          './server/tsconfig.json',
          './web/tsconfig.app.json',
          './web/tsconfig.node.json',
          './web/tsconfig.test.json',
          './shared/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: [
      '*.{js,mjs,ts}',
      'scripts/**',
      'e2e/**',
      'server/**',
      'shared/**',
      'web/vite.config.ts',
      '.claude/hooks/**',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
