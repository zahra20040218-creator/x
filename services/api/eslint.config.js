// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * CLAUDE.md §9: `strict: true`, no `any`, no `@ts-ignore` without a comment.
 *
 * The type-aware rules below are the ones that catch the failure modes this
 * codebase actually cares about - a forgotten `await` on a ledger write, or an
 * `any` that lets a float into a money field.
 */
export default tseslint.config(
  {
    // test/load holds k6 scripts. They are plain JavaScript run by the k6
    // binary, not by node and not through tsconfig, so the type-aware parser
    // has no project for them and reports a parse error rather than a lint.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/load/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md §9 - no `any`.
      '@typescript-eslint/no-explicit-any': 'error',

      // A dropped await on a ledger or state-machine call is a correctness bug,
      // not a style issue.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // @ts-ignore is allowed only with a stated reason (CLAUDE.md §9).
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // CLAUDE.md §11 - "no bare catch that swallows". This does not catch
      // every case, but it catches the empty-block form.
      'no-empty': ['error', { allowEmptyCatch: false }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    // Tests deliberately construct invalid values to prove they are rejected,
    // which needs casts the production rules forbid.
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
