// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The admin package declared a `lint` script but had no ESLint dependency and
 * no config, so `pnpm -r lint` had never actually linted this package — the
 * same class of never-executed tooling as the migrate script (D-18).
 *
 * The rules mirror `services/api/eslint.config.js` where they apply. What is
 * deliberately NOT carried over is the strictest type-aware set: this package
 * is a UI whose failure mode is a broken screen, not a corrupted ledger, and
 * the React ecosystem's types produce enough unavoidable friction that a
 * blanket `no-unsafe-*` would be turned off within a week. `no-explicit-any`
 * and `no-floating-promises` stay, because those catch real bugs anywhere.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        RequestInit: 'readonly',
        JSX: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',

      // React's own types return `any` in enough places that these fire on
      // correct code. The compiler already runs in strict mode over this
      // package, which covers the cases that matter here.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // An operator misreading a number is a money bug. Template literals over
      // numbers are normal in JSX and safe.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
