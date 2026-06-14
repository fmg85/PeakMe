// ESLint 9 flat config. Philosophy mirrors the backend ruff setup
// (docs/adr/ADR-013): catch *real* problems — undefined refs, unreachable code,
// genuine mistakes — not style. tsc already enforces types in the build, so this
// is the lightweight bug net on top.
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist',
      'dev-dist',
      'node_modules',
      'public',
      'vite.config.ts',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.serviceworker, // sw.ts: self, clients, skipWaiting, …
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript resolves identifiers/types; the base rule produces false
      // positives on type-only and ambient names. tsc is the source of truth.
      'no-undef': 'off',
      // Real-bug rules stay as errors (no-unused-vars surfaces dead code), but
      // don't fail the build over an intentional throwaway — prefix with _.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is used pragmatically in this codebase; not a correctness bug.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
