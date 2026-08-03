// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `noUndef` is redundant with TypeScript, which resolves every identifier
      // against browser + node lib types already.
      'no-undef': 'off',
      // The core deliberately pairs non-null assertions with
      // noUncheckedIndexedAccess for tight typed-array loops.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // tsc's noUnusedLocals / noUnusedParameters already enforce this, with a
      // clearer error surface than the lint rule.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
