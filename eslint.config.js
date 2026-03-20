import {
  configs,
  extensions,
  plugins,
} from 'eslint-config-airbnb-extended'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'

export default [
  {
    ignores: [
      'node_modules/',
      'dist/',
      'packages/figma-plugin/**',
    ],
  },
  plugins.stylistic,
  plugins.importX,
  plugins.typescriptEslint,
  plugins.node,
  ...configs.base.typescript,
  ...configs.node.recommended,
  ...extensions.base.typescript,
  ...extensions.node.recommended,
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
      'prefer-const': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      '@typescript-eslint/consistent-type-definitions':
        'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
]
