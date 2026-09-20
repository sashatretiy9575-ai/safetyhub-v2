import { fixupConfigRules } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// eslint-plugin-react and eslint-plugin-jsx-a11y (pulled in by eslint-config-next)
// still call the context methods ESLint 10 removed; the compat wrapper restores
// them so the shared config runs unchanged on the current ESLint.
const eslintConfig = defineConfig([
  ...fixupConfigRules(nextVitals),
  ...fixupConfigRules(nextTypescript),
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    'node_modules/**',
    'next-env.d.ts',
    // Working notes and one-off scripts, git-ignored by design: they never ship,
    // and lint errors in them hid the state of the code that does.
    'artifacts/**',
    // Deno edge functions are checked by the Supabase toolchain.
    'supabase/**',
  ]),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);

export default eslintConfig;
