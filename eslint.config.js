import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Flat ESLint configuration for the Infinigrow Hospital Cloud monorepo.
 *
 * Scope note: this config deliberately uses NON type-aware rules for Phase 0 so that
 * lint stays fast and cannot fail on cross-project type resolution. Type-aware
 * linting (`recommendedTypeChecked`) is planned for Phase 1, once the domain modules
 * exist and `parserOptions.projectService` has real projects to analyse.
 *
 * Architecture rules enforced here are documented in docs/ARCHITECTURE.md.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.local/**',
      '**/*.d.ts',
    ],
  },

  // ── JavaScript / TypeScript baseline ────────────────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── API (Node) ──────────────────────────────────────────────────────────────
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off', // enabled with type-aware linting
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  /**
   * Architecture rule: the HTTP and domain layers must not touch the database driver.
   *
   * `infrastructure/` owns Mongoose. Negated globs carve out that directory, the test
   * helpers, and test files, which legitimately need the driver to assert real
   * behaviour. Everything else — routes, controllers, services, middleware — is
   * blocked, so a data-access mistake fails lint rather than review.
   */
  {
    files: [
      'apps/api/src/**/*.ts',
      '!apps/api/src/infrastructure/**',
      '!apps/api/src/tests/**',
      '!**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'mongoose',
              message:
                'Mongoose may only be imported from apps/api/src/infrastructure. Go through the repository layer instead. See docs/ARCHITECTURE.md.',
            },
          ],
        },
      ],
    },
  },

  // Repositories are the only layer permitted to import model modules.
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [],
          patterns: [
            {
              group: ['**/infrastructure/db/models/*'],
              message:
                'Only repositories may import Mongoose models. Controllers and services must go through the repository layer.',
            },
          ],
        },
      ],
    },
  },

  // ── Web (browser) ───────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // XSS defence: React escaping is the default, never opt out of it silently.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is forbidden. Render text via JSX, or sanitise with an audited library and add a justification comment.',
        },
      ],
    },
  },

  // ── Tests may use non-null assertions and loose fixtures ────────────────────
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ── Config and script files ─────────────────────────────────────────────────
  // Globs must reach into `scripts/`: a bare `*.mjs` matches only the config's base
  // directory (the repo root), so `scripts/check-workspace-path.mjs` would be linted
  // without Node globals and fail on `no-undef`.
  {
    files: ['*.js', '*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
